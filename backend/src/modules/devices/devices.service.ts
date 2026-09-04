import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeviceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

const DEVICE_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private normaliseCode(raw: string): string {
    const code = (raw ?? '').trim().toUpperCase();
    if (!DEVICE_CODE_RE.test(code)) {
      throw new BadRequestException('Device code must be 2-30 chars: A-Z, 0-9, _ or -.');
    }
    return code;
  }

  /** Admin list. Workers never call this (ADMIN_WEB surface + stations.view). */
  async list(filter?: { status?: DeviceStatus; assignedWorkerId?: string }) {
    const where: Prisma.DeviceWhereInput = {};
    if (filter?.status) where.status = filter.status;
    if (filter?.assignedWorkerId) where.assignedWorkerId = filter.assignedWorkerId;
    return this.prisma.device.findMany({
      where,
      orderBy: [{ status: 'asc' }, { code: 'asc' }],
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
      },
    });
  }

  async findOne(idOrCode: string) {
    const code = idOrCode.trim().toUpperCase();
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ id: idOrCode }, { code }] },
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
      },
    });
    if (!device) throw new NotFoundException('Device not found.');
    return device;
  }

  async create(dto: CreateDeviceDto, actorUserId: string, ip?: string) {
    const code = this.normaliseCode(dto.code);
    const exists = await this.prisma.device.findUnique({ where: { code } });
    if (exists) throw new ConflictException('A device with that code already exists.');

    if (dto.workerId) await this.assertWorkerExists(dto.workerId);

    const device = await this.prisma.device.create({
      data: {
        code,
        name: dto.name.trim(),
        model: dto.model ?? null,
        stationCode: dto.stationCode?.trim().toUpperCase() ?? null,
        status: dto.status ?? 'ACTIVE',
        assignedWorkerId: dto.workerId ?? null,
      },
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'DEVICE_REGISTERED',
      entityType: 'device',
      entityId: device.id,
      ipAddress: ip,
      metadata: { code: device.code, workerId: dto.workerId ?? null },
    });
    return device;
  }

  async update(id: string, dto: UpdateDeviceDto, actorUserId: string, ip?: string) {
    const existing = await this.prisma.device.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Device not found.');

    const device = await this.prisma.device.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.model !== undefined ? { model: dto.model ?? null } : {}),
        ...(dto.stationCode !== undefined ? { stationCode: dto.stationCode.trim().toUpperCase() ?? null } : {}),
        ...(dto.appVersion !== undefined ? { appVersion: dto.appVersion } : {}),
      },
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'DEVICE_UPDATED',
      entityType: 'device',
      entityId: id,
      ipAddress: ip,
      metadata: { code: device.code },
    });
    return device;
  }

  async changeStatus(id: string, status: DeviceStatus, actorUserId: string, ip?: string) {
    const existing = await this.prisma.device.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Device not found.');

    const device = await this.prisma.device.update({
      where: { id },
      data: { status },
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'DEVICE_STATUS_CHANGED',
      entityType: 'device',
      entityId: id,
      ipAddress: ip,
      metadata: { code: existing.code, status },
    });

    // Disabling a device kills every live session bound to it immediately
    // (server-side, next request after disable): Doc1 §7/§12, Doc2 §11.
    if (status === 'DISABLED') {
      const revoked = await this.prisma.session.updateMany({
        where: { deviceId: id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      if (revoked.count > 0) {
        await this.audit.log({
          actorUserId,
          action: 'SESSION_REVOKED',
          entityType: 'session',
          entityId: id,
          ipAddress: ip,
          metadata: { reason: 'device_disabled', deviceCode: existing.code, count: revoked.count },
        });
      }
    }
    return device;
  }

  async assignWorker(id: string, workerId: string | null, actorUserId: string, ip?: string) {
    const existing = await this.prisma.device.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Device not found.');

    if (workerId) await this.assertWorkerExists(workerId);

    // Re-assigning a device to another worker revokes sessions of the
    // previous holder bound to this device (server-side isolation).
    if (existing.assignedWorkerId && existing.assignedWorkerId !== workerId) {
      const revoked = await this.prisma.session.updateMany({
        where: { deviceId: id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      if (revoked.count > 0) {
        await this.audit.log({
          actorUserId,
          action: 'SESSION_REVOKED',
          entityType: 'session',
          entityId: id,
          ipAddress: ip,
          metadata: { reason: 'device_reassigned', deviceCode: existing.code, count: revoked.count },
        });
      }
    }

    const device = await this.prisma.device.update({
      where: { id },
      data: { assignedWorkerId: workerId },
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
      },
    });

    await this.audit.log({
      actorUserId,
      action: 'DEVICE_ASSIGNED',
      entityType: 'device',
      entityId: id,
      ipAddress: ip,
      metadata: { code: existing.code, workerId },
    });
    return device;
  }

  /** Touched on every authenticated request from a device-bound session. */
  async touch(deviceId: string, ip?: string, appVersion?: string) {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(), lastSeenIp: ip ?? null, ...(appVersion ? { appVersion } : {}) },
    });
  }

  private async assertWorkerExists(workerId: string) {
    const worker = await this.prisma.user.findUnique({ where: { id: workerId } });
    if (!worker) throw new NotFoundException('Worker not found.');
  }
}
