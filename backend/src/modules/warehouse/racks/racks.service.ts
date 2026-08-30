import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ChildResourceService, ChildResourceConfig } from '../child-resource.base';
import { CreateRackDto } from './dto/create-rack.dto';
import { UpdateRackDto } from './dto/update-rack.dto';

@Injectable()
export class RacksService extends ChildResourceService {
  private readonly cfg: ChildResourceConfig = {
    model: 'rack',
    parentField: 'aisleId',
    uniqueKey: 'aisleId_code',
    scopedUniqueField: 'aisleId_code',
    parentExists: async (id) => !!(await this.prisma.aisle.findUnique({ where: { id } })),
    label: 'Rack',
    actionPrefix: 'RACK',
    entityType: 'rack',
  };

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  create(dto: CreateRackDto, actorUserId: string, ip?: string) {
    return super._create(this.cfg, { parentId: dto.aisleId, code: dto.code, name: dto.name, description: dto.description }, actorUserId, ip);
  }

  findOne(id: string) {
    return super._findOne(this.cfg, id);
  }

  listByAisle(aisleId: string) {
    return super._listByParent(this.cfg, 'aisleId', aisleId);
  }

  update(id: string, dto: UpdateRackDto, actorUserId: string, ip?: string) {
    return super._update(this.cfg, id, { name: dto.name, description: dto.description, code: dto.code }, actorUserId, ip);
  }

  activate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'ACTIVE', actorUserId, ip);
  }

  deactivate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'INACTIVE', actorUserId, ip);
  }
}
