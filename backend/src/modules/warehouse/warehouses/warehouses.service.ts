import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WarehouseStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { normalizeCode } from '../structure.util';

const entityType = 'warehouse';

@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateWarehouseDto, actorUserId: string, ip?: string) {
    const code = normalizeCode(dto.code);
    const exists = await this.prisma.warehouse.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`Warehouse code "${code}" already exists.`);

    const saved = await this.prisma.warehouse.create({
      data: { code, name: dto.name, description: dto.description ?? null },
    });
    await this.audit.log({
      actorUserId,
      action: 'WAREHOUSE_CREATED',
      entityType,
      entityId: saved.id,
      ipAddress: ip,
      metadata: { code: saved.code, name: saved.name },
    });
    return saved;
  }

  async findOne(id: string) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!wh) throw new NotFoundException('Warehouse not found.');
    return wh;
  }

  async findAll() {
    return this.prisma.warehouse.findMany({ orderBy: { code: 'asc' } });
  }

  async update(id: string, dto: UpdateWarehouseDto, actorUserId: string, ip?: string) {
    const wh = await this.findOne(id);
    const data: Prisma.WarehouseUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    // Code is allowed to change only if it does not collide with another.
    if (dto.code !== undefined) {
      const code = normalizeCode(dto.code);
      const clash = await this.prisma.warehouse.findFirst({ where: { code, NOT: { id } } });
      if (clash) throw new ConflictException(`Warehouse code "${code}" already exists.`);
      data.code = code;
    }
    const saved = await this.prisma.warehouse.update({ where: { id }, data });
    await this.audit.log({
      actorUserId,
      action: 'WAREHOUSE_UPDATED',
      entityType,
      entityId: id,
      ipAddress: ip,
      metadata: { code: saved.code, previous: { status: wh.status, name: wh.name } },
    });
    return saved;
  }

  async setStatus(id: string, status: WarehouseStatus, actorUserId: string, ip?: string) {
    const wh = await this.findOne(id);
    const saved = await this.prisma.warehouse.update({ where: { id }, data: { status } });
    const action = status === 'ACTIVE' ? 'WAREHOUSE_ACTIVATED' : 'WAREHOUSE_DEACTIVATED';
    await this.audit.log({
      actorUserId,
      action,
      entityType,
      entityId: id,
      ipAddress: ip,
      metadata: { code: saved.code, from: wh.status, to: status },
    });
    return saved;
  }

  /**
   * Returns the nested physical structure tree of a warehouse:
   * zones -> aisles -> racks -> levels -> locations.
   * Used by the Structure Explorer screen.
   */
  async structure(id: string) {
    await this.findOne(id);
    const zones = await this.prisma.zone.findMany({
      where: { warehouseId: id },
      orderBy: { code: 'asc' },
      include: {
        aisles: {
          orderBy: { code: 'asc' },
          include: {
            racks: {
              orderBy: { code: 'asc' },
              include: {
                levels: { orderBy: { levelNumber: 'asc' } },
              },
            },
          },
        },
      },
    });
    const locations = await this.prisma.location.findMany({
      where: { warehouseId: id },
      orderBy: { locationCode: 'asc' },
    });
    // Attach locations to their level node without mutating prisma objects.
    const byLevel: Record<string, typeof locations> = {};
    for (const l of locations) (byLevel[l.levelId] ??= []).push(l);
    return zones.map((z) => ({
      ...z,
      aisles: z.aisles.map((a) => ({
        ...a,
        racks: a.racks.map((r) => ({
          ...r,
          levels: r.levels.map((lv) => ({ ...lv, locations: byLevel[lv.id] ?? [] })),
        })),
      })),
    }));
  }
}
