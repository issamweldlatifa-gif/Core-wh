import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, LocationStatus, LocationType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { ListLocationsQuery } from './dto/list-locations.query';
import { SearchLocationsQuery } from './dto/search-locations.query';
import { buildLocationCode } from '../structure.util';

const entityType = 'location';

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verifies the FULL ancestry of a Location is a single valid chain, i.e. that
   * the supplied warehouseId, zoneId, aisleId, rackId and levelId all belong to
   * the same parent chain (D-30 "Location Integrity"). Throws BadRequest on any
   * mismatch. Runs inside the caller's transaction where possible.
   */
  private async assertParentChain(tx: Prisma.TransactionClient, dto: {
    warehouseId: string; zoneId: string; aisleId: string; rackId: string; levelId: string;
  }) {
    const level = await tx.level.findUnique({
      where: { id: dto.levelId },
      include: { rack: { include: { aisle: { include: { zone: { include: { warehouse: true } } } } } } },
    });
    if (!level) throw new NotFoundException('Level not found.');
    const rack = level.rack;
    const aisle = rack.aisle;
    const zone = aisle.zone;
    const warehouse = zone.warehouse;
    const mismatched: string[] = [];
    if (rack.id !== dto.rackId) mismatched.push('rack does not match level.rack');
    if (aisle.id !== dto.aisleId) mismatched.push('aisle does not match rack.aisle');
    if (zone.id !== dto.zoneId) mismatched.push('zone does not match aisle.zone');
    if (zone.warehouseId !== dto.warehouseId) mismatched.push('warehouse does not match zone.warehouse');
    if (mismatched.length) {
      throw new BadRequestException(`Invalid parent hierarchy: ${mismatched.join('; ')}.`);
    }
    return { level, rack, aisle, zone, warehouse };
  }

  async create(dto: CreateLocationDto, actorUserId: string, ip?: string) {
    return this.prisma.$transaction(async (tx) => {
      const chain = await this.assertParentChain(tx, dto);
      const locationCode = buildLocationCode(chain.warehouse.code, chain.zone.code, chain.aisle.code, chain.rack.code, chain.level.code);

      const dup = await tx.location.findFirst({
        where: { OR: [{ locationCode }, { barcodeValue: locationCode }] },
      });
      if (dup) throw new BadRequestException(`Location code "${locationCode}" already exists.`);

      const location = await tx.location.create({
        data: {
          warehouseId: dto.warehouseId,
          zoneId: dto.zoneId,
          aisleId: dto.aisleId,
          rackId: dto.rackId,
          levelId: dto.levelId,
          locationCode,
          // D-33: barcodeValue = locationCode by default (unique + stable).
          barcodeValue: locationCode,
          qrValue: dto.qrValue ?? null,
          locationType: dto.locationType,
          status: dto.status ?? 'ACTIVE',
          maxWeight: dto.maxWeight ?? null,
          maxVolume: dto.maxVolume ?? null,
          maxUnits: dto.maxUnits ?? null,
        },
      });
      await this.audit.log({
        actorUserId,
        action: 'LOCATION_CREATED',
        entityType,
        entityId: location.id,
        ipAddress: ip,
        metadata: { locationCode, warehouseId: location.warehouseId },
      });
      return location;
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.location.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Location not found.');
    return row;
  }

  async findAll(query: ListLocationsQuery) {
    const where: Prisma.LocationWhereInput = {};
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.status) where.status = query.status as LocationStatus;
    if (query.locationType) where.locationType = query.locationType as LocationType;

    const skip = query.skip ?? 0;
    const take = Math.min(query.take ?? 50, 200);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({
        where,
        orderBy: { locationCode: 'asc' },
        skip,
        take,
      }),
      this.prisma.location.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  /** Fast indexed search over the location code / barcode (D-30 §25). */
  async search(query: SearchLocationsQuery) {
    const term = (query.q ?? '').trim().toUpperCase();
    const where: Prisma.LocationWhereInput = {
      OR: [
        { locationCode: { contains: term, mode: 'insensitive' } },
        { barcodeValue: { contains: term, mode: 'insensitive' } },
      ],
    };
    if (query.warehouseId) where.warehouseId = query.warehouseId;
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.status) where.status = query.status as LocationStatus;
    if (query.locationType) where.locationType = query.locationType as LocationType;

    const skip = query.skip ?? 0;
    const take = Math.min(query.take ?? 50, 200);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.location.findMany({ where, orderBy: { locationCode: 'asc' }, skip, take }),
      this.prisma.location.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async update(id: string, dto: UpdateLocationDto, actorUserId: string, ip?: string) {
    const existing = await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      // Reparenting is permitted only if the new chain is fully consistent.
      const target = {
        warehouseId: dto.warehouseId ?? existing.warehouseId,
        zoneId: dto.zoneId ?? existing.zoneId,
        aisleId: dto.aisleId ?? existing.aisleId,
        rackId: dto.rackId ?? existing.rackId,
        levelId: dto.levelId ?? existing.levelId,
      };
      const chain = await this.assertParentChain(tx, target);
      const locationCode = buildLocationCode(chain.warehouse.code, chain.zone.code, chain.aisle.code, chain.rack.code, chain.level.code);

      const dup = await tx.location.findFirst({
        where: { AND: [{ locationCode }, { NOT: { id } }] },
      });
      if (dup) throw new BadRequestException(`Location code "${locationCode}" already exists.`);

      const location = await tx.location.update({
        where: { id },
        data: {
          warehouseId: target.warehouseId,
          zoneId: target.zoneId,
          aisleId: target.aisleId,
          rackId: target.rackId,
          levelId: target.levelId,
          // locationCode / barcodeValue are recomputed from the (possibly new)
          // chain; they are read-only w.r.t. external input (D-30).
          locationCode,
          barcodeValue: locationCode,
          qrValue: dto.qrValue !== undefined ? dto.qrValue : existing.qrValue,
          locationType: dto.locationType ?? existing.locationType,
          status: dto.status ?? existing.status,
          maxWeight: dto.maxWeight !== undefined ? dto.maxWeight : existing.maxWeight,
          maxVolume: dto.maxVolume !== undefined ? dto.maxVolume : existing.maxVolume,
          maxUnits: dto.maxUnits !== undefined ? dto.maxUnits : existing.maxUnits,
        },
      });
      await this.audit.log({
        actorUserId,
        action: 'LOCATION_UPDATED',
        entityType,
        entityId: id,
        ipAddress: ip,
        metadata: { locationCode, warehouseId: location.warehouseId, previous: { status: existing.status, locationType: existing.locationType } },
      });
      return location;
    });
  }

  async setStatus(id: string, status: LocationStatus, actorUserId: string, ip?: string) {
    const existing = await this.findOne(id);
    const saved = await this.prisma.location.update({ where: { id }, data: { status } });
    const actionMap: Record<LocationStatus, string> = {
      ACTIVE: 'LOCATION_ACTIVATED',
      INACTIVE: 'LOCATION_DEACTIVATED',
      BLOCKED: 'LOCATION_BLOCKED',
    };
    // LOCATION_UNBLOCKED is logged specially (BLOCKED -> ACTIVE).
    const action = status === 'ACTIVE' && existing.status === 'BLOCKED' ? 'LOCATION_UNBLOCKED' : actionMap[status];
    await this.audit.log({
      actorUserId,
      action: action as any,
      entityType,
      entityId: id,
      ipAddress: ip,
      metadata: { locationCode: saved.locationCode, from: existing.status, to: status },
    });
    return saved;
  }

  async block(id: string, actorUserId: string, ip?: string) {
    return this.setStatus(id, 'BLOCKED', actorUserId, ip);
  }

  async unblock(id: string, actorUserId: string, ip?: string) {
    return this.setStatus(id, 'ACTIVE', actorUserId, ip);
  }
}
