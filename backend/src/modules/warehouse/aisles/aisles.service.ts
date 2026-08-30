import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ChildResourceService, ChildResourceConfig } from '../child-resource.base';
import { CreateAisleDto } from './dto/create-aisle.dto';
import { UpdateAisleDto } from './dto/update-aisle.dto';

@Injectable()
export class AislesService extends ChildResourceService {
  private readonly cfg: ChildResourceConfig = {
    model: 'aisle',
    parentField: 'zoneId',
    uniqueKey: 'zoneId_code',
    scopedUniqueField: 'zoneId_code',
    parentExists: async (id) => !!(await this.prisma.zone.findUnique({ where: { id } })),
    label: 'Aisle',
    actionPrefix: 'AISLE',
    entityType: 'aisle',
  };

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  create(dto: CreateAisleDto, actorUserId: string, ip?: string) {
    return super._create(this.cfg, { parentId: dto.zoneId, code: dto.code, name: dto.name, description: dto.description }, actorUserId, ip);
  }

  findOne(id: string) {
    return super._findOne(this.cfg, id);
  }

  listByZone(zoneId: string) {
    return super._listByParent(this.cfg, 'zoneId', zoneId);
  }

  update(id: string, dto: UpdateAisleDto, actorUserId: string, ip?: string) {
    return super._update(this.cfg, id, { name: dto.name, description: dto.description, code: dto.code }, actorUserId, ip);
  }

  activate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'ACTIVE', actorUserId, ip);
  }

  deactivate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'INACTIVE', actorUserId, ip);
  }
}
