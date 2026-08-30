import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UpsertWarehouseDto } from './dto/upsert-warehouse.dto';

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async upsert(dto: UpsertWarehouseDto, actorUserId: string, ip?: string) {
    const saved = await this.prisma.warehouse.upsert({
      where: { code: dto.code },
      update: { name: dto.name, address: dto.address ?? null },
      create: { code: dto.code, name: dto.name, address: dto.address ?? null },
    });
    await this.audit.log({
      actorUserId,
      action: 'WAREHOUSE_UPDATED',
      entityType: 'warehouse',
      entityId: saved.id,
      ipAddress: ip,
      metadata: { code: saved.code },
    });
    return saved;
  }

  async findAll() {
    return this.prisma.warehouse.findMany({ orderBy: { code: 'asc' } });
  }

  async findOne(id: string) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!wh) throw new NotFoundException('Warehouse not found.');
    return wh;
  }
}
