import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StationCapability, StationDepartment, StationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Station registry (spec §10).
 *
 * A Station is a physical work position: a code, a department, a status, an
 * optional assigned worker/device and a capability set. The receiving
 * workflow never branches on capabilities (§11) — they only tell the terminal
 * which input affordances to offer, so adding hardware never forks business
 * logic.
 */
export interface StationActor {
  id: string;
  ip?: string;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;

@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Validate a zone id exists (S11: the zone link is admin config, not code). */
  private async assertZone(zoneId: string): Promise<string> {
    const zone = await this.prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) throw new NotFoundException(`Zone "${zoneId}" not found.`);
    return zoneId;
  }

  private normaliseCode(raw: string): string {
    const code = (raw ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      throw new BadRequestException('Station code must be 2-30 chars: A-Z, 0-9, _ or -.');
    }
    return code;
  }

  async list(filter?: { department?: StationDepartment; status?: StationStatus }) {
    const where: Prisma.StationWhereInput = {};
    if (filter?.department) where.department = filter.department;
    if (filter?.status) where.status = filter.status;
    return this.prisma.station.findMany({
      where,
      orderBy: [{ department: 'asc' }, { code: 'asc' }],
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
        // Master Order §11: station↔zone is admin-visible configuration.
        zone: { select: { id: true, code: true, warehouseId: true } },
      },
    });
  }

  async findOne(id: string) {
    const station = await this.prisma.station.findFirst({
      where: { OR: [{ id }, { code: id.toUpperCase() }] },
      include: {
        assignedWorker: { select: { id: true, name: true, employeeCode: true } },
        zone: { select: { id: true, code: true, warehouseId: true } },
      },
    });
    if (!station) throw new NotFoundException('Station not found.');
    return station;
  }

  async create(
    input: {
      code: string;
      name: string;
      department: StationDepartment;
      capabilities?: StationCapability[];
      deviceId?: string | null;
      warehouseId?: string | null;
      /** Master Order §11: the station/zone link is created as configuration. */
      zoneId?: string | null;
    },
    actor: StationActor,
  ) {
    const code = this.normaliseCode(input.code);
    const clash = await this.prisma.station.findUnique({ where: { code } });
    if (clash) throw new ConflictException(`Station code "${code}" already exists.`);
    const zoneId = input.zoneId ? await this.assertZone(input.zoneId) : null;

    const station = await this.prisma.station.create({
      data: {
        code,
        name: input.name.trim(),
        department: input.department,
        capabilities: input.capabilities ?? [],
        deviceId: input.deviceId ?? null,
        warehouseId: input.warehouseId ?? null,
        zoneId,
      },
      include: { zone: { select: { id: true, code: true, warehouseId: true } } },
    });
    await this.audit.log({
      actorUserId: actor.id,
      action: 'STATION_CREATED' as never,
      entityType: 'station',
      entityId: station.id,
      ipAddress: actor.ip,
      metadata: { code, department: station.department, zoneId },
    });
    return station;
  }

  async update(
    id: string,
    input: {
      name?: string;
      capabilities?: StationCapability[];
      deviceId?: string | null;
      /** Master Order §11: admin configures the station's department. */
      department?: string;
      /** Master Order §11: admin configures the zone a station sits in (required for STAGING). */
      zoneId?: string | null;
    },
    actor: StationActor,
  ) {
    const station = await this.findOne(id);
    // Unchecked variant: the station's Device link is expressed through the
    // deviceId FK (C-8 made Device a real relation; the FK stays the input).
    const data: Prisma.StationUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.capabilities !== undefined) data.capabilities = input.capabilities;
    if (input.deviceId !== undefined) {
      if (input.deviceId) {
        const device = await this.prisma.device.findUnique({ where: { id: input.deviceId } });
        if (!device) throw new NotFoundException(`Device "${input.deviceId}" not found.`);
      }
      data.deviceId = input.deviceId;
    }
    if (input.department !== undefined) {
      const departments = ['RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH', 'STAGING', 'BATCH'];
      if (!departments.includes(input.department)) {
        throw new BadRequestException(`department must be one of: ${departments.join(', ')}`);
      }
      data.department = input.department as never;
    }
    if (input.zoneId !== undefined) data.zoneId = input.zoneId ? await this.assertZone(input.zoneId) : null;

    const saved = await this.prisma.station.update({ where: { id: station.id }, data });
    await this.audit.log({
      actorUserId: actor.id,
      action: 'STATION_UPDATED' as never,
      entityType: 'station',
      entityId: station.id,
      ipAddress: actor.ip,
      metadata: {
        code: saved.code,
        changed: {
          name: input.name !== undefined,
          department: input.department !== undefined ? input.department : null,
          zoneId: input.zoneId !== undefined ? input.zoneId : null,
          deviceId: input.deviceId !== undefined ? input.deviceId : null,
        },
      },
    });
    return saved;
  }

  async setStatus(id: string, status: StationStatus, actor: StationActor) {
    const station = await this.findOne(id);
    const saved = await this.prisma.station.update({ where: { id: station.id }, data: { status } });
    await this.audit.log({
      actorUserId: actor.id,
      action: 'STATION_STATUS_CHANGED' as never,
      entityType: 'station',
      entityId: station.id,
      ipAddress: actor.ip,
      metadata: { code: saved.code, from: station.status, to: status },
    });
    return saved;
  }

  /**
   * Assign (or clear, with `workerId = null`) the station's worker.
   * A worker may hold at most one station at a time: assigning elsewhere
   * releases the previous one so the floor view can never show one person
   * at two positions.
   */
  async assign(id: string, workerId: string | null, actor: StationActor) {
    const station = await this.findOne(id);

    if (workerId) {
      const worker = await this.prisma.user.findUnique({ where: { id: workerId } });
      if (!worker) throw new NotFoundException('Worker not found.');
      if (worker.status !== 'ACTIVE') throw new ConflictException('Worker is not active.');
      await this.prisma.station.updateMany({
        where: { assignedWorkerId: workerId, id: { not: station.id } },
        data: { assignedWorkerId: null },
      });
    }

    const saved = await this.prisma.station.update({
      where: { id: station.id },
      data: { assignedWorkerId: workerId },
      include: { assignedWorker: { select: { id: true, name: true, employeeCode: true } } },
    });
    await this.audit.log({
      actorUserId: actor.id,
      action: (workerId ? 'STATION_ASSIGNED' : 'STATION_UNASSIGNED') as never,
      entityType: 'station',
      entityId: station.id,
      ipAddress: actor.ip,
      metadata: { code: saved.code, workerId },
    });
    return saved;
  }

  /** The station a given worker is currently standing at, if any. */
  async forWorker(workerId: string) {
    return this.prisma.station.findFirst({
      where: { assignedWorkerId: workerId, status: 'ACTIVE' },
    });
  }
}
