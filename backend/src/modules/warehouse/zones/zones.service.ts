import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ChildResourceService, ChildResourceConfig } from '../child-resource.base';
import { CreateZoneDto } from './dto/create-zone.dto';
import { UpdateZoneDto } from './dto/update-zone.dto';

@Injectable()
export class ZonesService extends ChildResourceService {
  private readonly cfg: ChildResourceConfig = {
    model: 'zone',
    parentField: 'warehouseId',
    uniqueKey: 'warehouseId_code',
    scopedUniqueField: 'warehouseId_code',
    parentExists: async (id) => !!(await this.prisma.warehouse.findUnique({ where: { id } })),
    label: 'Zone',
    actionPrefix: 'ZONE',
    entityType: 'zone',
  };

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  create(dto: CreateZoneDto, actorUserId: string, ip?: string) {
    return super._create(this.cfg, { parentId: dto.warehouseId, code: dto.code, name: dto.name, description: dto.description }, actorUserId, ip);
  }

  findOne(id: string) {
    return super._findOne(this.cfg, id);
  }

  listByWarehouse(warehouseId: string) {
    return super._listByParent(this.cfg, 'warehouseId', warehouseId);
  }

  update(id: string, dto: UpdateZoneDto, actorUserId: string, ip?: string) {
    return super._update(this.cfg, id, { name: dto.name, description: dto.description }, actorUserId, ip);
  }

  activate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'ACTIVE', actorUserId, ip);
  }

  deactivate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'INACTIVE', actorUserId, ip);
  }
}
