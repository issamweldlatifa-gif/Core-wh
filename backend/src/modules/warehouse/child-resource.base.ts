import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Generic service for the hierarchical child resources that share the same
 * shape: Zone, Aisle, Rack, Level. Each has:
 *   - a single parent FK (scoped uniqueness by parent),
 *   - a `code`, `name`, optional `description`, and an ACTIVE/INACTIVE `status`,
 *   - create/update/activate/deactivate + list-by-parent.
 *
 * Location is deliberately NOT handled here (it has richer, denormalized
 * integrity rules — see locations.service.ts).
 */
export interface ChildResourceConfig {
  model: 'zone' | 'aisle' | 'rack' | 'level';
  /** Prisma relation field name on the parent, e.g. 'warehouseId' for Zone. */
  parentField: string;
  /** The composite unique where key for (parent, code), e.g. 'warehouseId_code'. */
  uniqueKey: string;
  /** The scoped unique index field name, e.g. 'warehouseId_code'. */
  scopedUniqueField: string;
  /** Parent finder (cheap existence check). */
  parentExists: (id: string) => Promise<boolean>;
  /** Uppercase entity name used in audit + messages, e.g. 'Zone'. */
  label: string;
  /** Audit action prefix, e.g. 'ZONE'. */
  actionPrefix: string;
  entityType: string;
}

export interface CreateChildInput {
  parentId: string;
  code: string;
  name: string;
  description?: string;
  /** For Level only: numeric order. */
  levelNumber?: number;
}

export interface UpdateChildInput {
  name?: string;
  description?: string;
  /** For Level only. */
  code?: string;
  levelNumber?: number;
}

@Injectable()
export class ChildResourceService {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly audit: AuditService,
  ) {}

  /** Common create logic for all child resources. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _create(cfg: ChildResourceConfig, input: CreateChildInput, actorUserId: string, ip?: string): Promise<any> {
    if (!(await cfg.parentExists(input.parentId))) {
      throw new NotFoundException(`${cfg.label} parent not found.`);
    }
    const code = (input.code ?? '').trim().toUpperCase();
    // Scoped duplicate check (parent + code).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where = { [cfg.scopedUniqueField]: { [cfg.parentField]: input.parentId, code } } as any;
    const existing = await this._findOneBy(cfg, cfg.parentField, input.parentId, code);
    if (existing) throw new ConflictException(`${cfg.label} code "${code}" already exists in this parent.`);

    const data: Record<string, unknown> = {
      code,
      [cfg.parentField]: input.parentId,
    };
    // Level has no `name`/`description` fields (code + numeric order only).
    if (cfg.model !== 'level') {
      data.name = input.name;
      data.description = input.description ?? null;
    }
    if (cfg.model === 'level' && input.levelNumber !== undefined) data.levelNumber = input.levelNumber;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (this.prisma as any)[cfg.model].create({ data });
    // (audit) 
    await this.audit.log({
      actorUserId,
      action: `${cfg.actionPrefix}_CREATED` as any,
      entityType: cfg.entityType,
      entityId: created.id,
      ipAddress: ip,
      metadata: { code, parentId: input.parentId },
    });
    return created;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _findOneBy(cfg: ChildResourceConfig, parentField: string, parentId: string, code: string): Promise<any | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any)[cfg.model].findFirst({ where: { [parentField]: parentId, code } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _findOne(cfg: ChildResourceConfig, id: string): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (this.prisma as any)[cfg.model].findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`${cfg.label} not found.`);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _listByParent(cfg: ChildResourceConfig, parentField: string, parentId: string): Promise<any[]> {
    // The parent id arrives from a required query param. When the caller omits
    // it, Prisma would receive `undefined` and throw a 500. A missing/blank
    // filter is a CLIENT error, so answer 400 with an actionable message.
    if (typeof parentId !== 'string' || parentId.trim() === '') {
      throw new BadRequestException(`Query parameter "${parentField}" is required to list ${cfg.label.toLowerCase()}s.`);
    }
    if (!(await cfg.parentExists(parentId))) throw new NotFoundException(`${cfg.label} parent not found.`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any)[cfg.model].findMany({ where: { [parentField]: parentId }, orderBy: { code: 'asc' } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _update(cfg: ChildResourceConfig, id: string, input: UpdateChildInput, actorUserId: string, ip?: string): Promise<any> {
    const row = await this._findOne(cfg, id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (cfg.model === 'level' && input.levelNumber !== undefined) data.levelNumber = input.levelNumber;
    if (input.code !== undefined) {
      const code = input.code.trim().toUpperCase();
      const clash = await this._findOneBy(cfg, cfg.parentField, row[cfg.parentField], code);
      if (clash && clash.id !== id) throw new ConflictException(`${cfg.label} code "${code}" already exists in this parent.`);
      data.code = code;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = await (this.prisma as any)[cfg.model].update({ where: { id }, data });
    // (audit) 
    await this.audit.log({
      actorUserId,
      action: `${cfg.actionPrefix}_UPDATED` as any,
      entityType: cfg.entityType,
      entityId: id,
      ipAddress: ip,
      metadata: { code: saved.code },
    });
    return saved;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _setStatus(cfg: ChildResourceConfig, id: string, status: 'ACTIVE' | 'INACTIVE', actorUserId: string, ip?: string): Promise<any> {
    const row = await this._findOne(cfg, id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = await (this.prisma as any)[cfg.model].update({ where: { id }, data: { status } });
    // (audit) 
    await this.audit.log({
      actorUserId,
      action: (status === 'ACTIVE' ? `${cfg.actionPrefix}_ACTIVATED` : `${cfg.actionPrefix}_DEACTIVATED`) as any,
      entityType: cfg.entityType,
      entityId: id,
      ipAddress: ip,
      metadata: { code: saved.code, from: row.status, to: status },
    });
    return saved;
  }
}
