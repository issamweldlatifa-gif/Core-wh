import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { ChildResourceService, ChildResourceConfig } from '../child-resource.base';
import { CreateLevelDto } from './dto/create-level.dto';
import { UpdateLevelDto } from './dto/update-level.dto';
import { levelCodeFromNumber } from '../structure.util';

@Injectable()
export class LevelsService extends ChildResourceService {
  private readonly cfg: ChildResourceConfig = {
    model: 'level',
    parentField: 'rackId',
    uniqueKey: 'rackId_code',
    scopedUniqueField: 'rackId_code',
    parentExists: async (id) => !!(await this.prisma.rack.findUnique({ where: { id } })),
    label: 'Level',
    actionPrefix: 'LEVEL',
    entityType: 'level',
  };

  constructor(prisma: PrismaService, audit: AuditService) {
    super(prisma, audit);
  }

  async create(dto: CreateLevelDto, actorUserId: string, ip?: string) {
    // D-36: code is auto-derived from the numeric level order (1 -> L01 ...).
    const code = levelCodeFromNumber(dto.levelNumber);
    const existingByNum = await this.prisma.level.findFirst({
      where: { rackId: dto.rackId, levelNumber: dto.levelNumber },
    });
    if (existingByNum) {
      throw new ConflictException(`Level ${dto.levelNumber} already exists on this rack.`);
    }
    return super._create(this.cfg, { parentId: dto.rackId, code, name: code, levelNumber: dto.levelNumber }, actorUserId, ip);
  }

  findOne(id: string) {
    return super._findOne(this.cfg, id);
  }

  listByRack(rackId: string) {
    return super._listByParent(this.cfg, 'rackId', rackId);
  }

  async update(id: string, dto: UpdateLevelDto, actorUserId: string, ip?: string) {
    // Changing the numeric order re-derives the display code automatically.
    const levelNumber = dto.levelNumber;
    return super._update(this.cfg, id, {
      ...dto,
      code: dto.levelNumber !== undefined ? levelCodeFromNumber(dto.levelNumber) : undefined,
    }, actorUserId, ip);
  }

  activate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'ACTIVE', actorUserId, ip);
  }

  deactivate(id: string, actorUserId: string, ip?: string) {
    return super._setStatus(this.cfg, id, 'INACTIVE', actorUserId, ip);
  }
}
