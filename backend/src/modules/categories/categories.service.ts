import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CategoryStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Category Master + Category -> Zone sorting configuration.
 *
 * The master is the controlled vocabulary for product categories: CRM cards
 * are validated against it at intake (expected-arrivals.service). The zone
 * mapping is warehouse CONFIGURATION — sorting reads it at runtime; nothing
 * is hardcoded (no "SHOES => zone SHOES" anywhere in code).
 *
 * Every mutation is audited (CATEGORY_* / CATEGORY_MAPPING_* actions).
 */
export interface CategoryActor {
  id: string;
  ip?: string | null;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private normaliseCode(raw: string, label = 'Category code'): string {
    const code = (raw ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      throw new BadRequestException(`${label} must be 2-40 chars: A-Z, 0-9, _ or -.`);
    }
    return code;
  }

  // ---------------- master ----------------

  async list(includeInactive = true) {
    return this.prisma.categoryMaster.findMany({
      where: includeInactive ? {} : { status: 'ACTIVE' },
      orderBy: { code: 'asc' },
      include: {
        zoneMappings: {
          include: { zone: { select: { id: true, code: true, name: true, warehouseId: true } } },
        },
      },
    });
  }

  async create(
    body: { code: string; name?: string; subcategories?: string[] },
    actor: CategoryActor,
  ) {
    const code = this.normaliseCode(body.code);
    const existing = await this.prisma.categoryMaster.findUnique({ where: { code } });
    if (existing) throw new ConflictException(`Category ${code} already exists.`);
    const subcategories = (body.subcategories ?? []).map((s) =>
      this.normaliseCode(s, 'Subcategory code'),
    );

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.categoryMaster.create({
        data: { code, name: body.name?.trim() || code, subcategories },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CATEGORY_CREATED' as never,
          entityType: 'category',
          entityId: row.id,
          ipAddress: actor.ip ?? null,
          metadata: { code, subcategories },
        },
        tx,
      );
      return row;
    });
  }

  async update(
    id: string,
    body: { name?: string; subcategories?: string[] },
    actor: CategoryActor,
  ) {
    const row = await this.prisma.categoryMaster.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Category not found.');
    const subcategories = body.subcategories
      ? body.subcategories.map((s) => this.normaliseCode(s, 'Subcategory code'))
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.categoryMaster.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim() || row.code } : {}),
          ...(subcategories !== undefined ? { subcategories } : {}),
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CATEGORY_UPDATED' as never,
          entityType: 'category',
          entityId: id,
          ipAddress: actor.ip ?? null,
          metadata: { code: row.code, before: { name: row.name, subcategories: row.subcategories }, after: { name: updated.name, subcategories: updated.subcategories } },
        },
        tx,
      );
      return updated;
    });
  }

  async setStatus(id: string, status: CategoryStatus, actor: CategoryActor) {
    const row = await this.prisma.categoryMaster.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Category not found.');
    if (row.status === status) return row;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.categoryMaster.update({ where: { id }, data: { status } });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CATEGORY_STATUS_CHANGED' as never,
          entityType: 'category',
          entityId: id,
          ipAddress: actor.ip ?? null,
          metadata: { code: row.code, from: row.status, to: status },
        },
        tx,
      );
      return updated;
    });
  }

  // ---------------- zone mapping (sorting configuration) ----------------

  /** Set/replace the destination zone for a category (config, not code). */
  async setZoneMapping(categoryId: string, zoneId: string, actor: CategoryActor) {
    const category = await this.prisma.categoryMaster.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException('Category not found.');
    const zone = await this.prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) throw new NotFoundException('Zone not found.');
    if (zone.status !== 'ACTIVE') {
      throw new BadRequestException(`Zone ${zone.code} is not ACTIVE and cannot be a sorting destination.`);
    }

    return this.prisma.$transaction(async (tx) => {
      // One destination per category (per warehouse implicitly via the zone):
      // replace any existing mapping for this category in the same warehouse.
      const existing = await tx.categoryZoneMapping.findMany({
        where: { categoryId, zone: { warehouseId: zone.warehouseId } },
        include: { zone: true },
      });
      for (const m of existing) {
        await tx.categoryZoneMapping.delete({ where: { id: m.id } });
      }
      const row = await tx.categoryZoneMapping.create({
        data: { categoryId, zoneId },
        include: { zone: { select: { id: true, code: true, name: true, warehouseId: true } } },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CATEGORY_MAPPING_SET' as never,
          entityType: 'category',
          entityId: categoryId,
          ipAddress: actor.ip ?? null,
          metadata: {
            category: category.code,
            zone: zone.code,
            replaced: existing.map((m) => m.zone.code),
          },
        },
        tx,
      );
      return row;
    });
  }

  async removeZoneMapping(categoryId: string, zoneId: string, actor: CategoryActor) {
    const mapping = await this.prisma.categoryZoneMapping.findUnique({
      where: { categoryId_zoneId: { categoryId, zoneId } },
      include: { category: true, zone: true },
    });
    if (!mapping) throw new NotFoundException('Mapping not found.');

    return this.prisma.$transaction(async (tx) => {
      await tx.categoryZoneMapping.delete({ where: { id: mapping.id } });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CATEGORY_MAPPING_REMOVED' as never,
          entityType: 'category',
          entityId: categoryId,
          ipAddress: actor.ip ?? null,
          metadata: { category: mapping.category.code, zone: mapping.zone.code },
        },
        tx,
      );
      return { removed: true };
    });
  }

  // ---------------- destination resolution (used by sorting/putaway) -------

  /**
   * Resolve the configured sorting destination for a set of category codes.
   * Returns one destination ONLY when the categories resolve unambiguously:
   *  - NEEDS_REVIEW / UNKNOWN present        -> { kind: 'NEEDS_REVIEW' }
   *  - no mapping configured                 -> { kind: 'UNMAPPED' }
   *  - multiple different destination zones  -> { kind: 'AMBIGUOUS' }
   * A wrong destination is never emitted.
   */
  async resolveDestination(categoryCodes: string[]): Promise<
    | { kind: 'DESTINATION'; zone: { id: string; code: string; name: string } }
    | { kind: 'NEEDS_REVIEW' }
    | { kind: 'UNMAPPED'; categories: string[] }
    | { kind: 'AMBIGUOUS'; zones: string[] }
  > {
    const codes = Array.from(new Set(categoryCodes.map((c) => c.trim().toUpperCase())));
    if (codes.length === 0 || codes.includes('UNKNOWN') || codes.includes('NEEDS_REVIEW')) {
      return { kind: 'NEEDS_REVIEW' };
    }
    const mappings = await this.prisma.categoryZoneMapping.findMany({
      where: { category: { code: { in: codes }, status: 'ACTIVE' } },
      include: {
        category: { select: { code: true } },
        zone: { select: { id: true, code: true, name: true, status: true } },
      },
    });
    const mappedCodes = new Set(mappings.map((m) => m.category.code));
    const unmapped = codes.filter((c) => !mappedCodes.has(c));
    if (unmapped.length > 0) return { kind: 'UNMAPPED', categories: unmapped };

    const activeZones = mappings.filter((m) => m.zone.status === 'ACTIVE');
    if (activeZones.length === 0) return { kind: 'UNMAPPED', categories: codes };
    const distinct = new Map(activeZones.map((m) => [m.zone.id, m.zone]));
    if (distinct.size > 1) {
      return { kind: 'AMBIGUOUS', zones: Array.from(distinct.values()).map((z) => z.code) };
    }
    const zone = Array.from(distinct.values())[0];
    return { kind: 'DESTINATION', zone: { id: zone.id, code: zone.code, name: zone.name } };
  }
}
