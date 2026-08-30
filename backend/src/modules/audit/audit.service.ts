import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEventInput {
  actorUserId: string | null;
  action: AuditAction;
  entityType?: string | null;
  entityId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Audit-ready by design. Every sensitive write (login, role/permission
 * changes, user changes, settings changes) is recorded here. Later phases
 * add operational events (ITEM_RECEIVED, ORDER_PACKED, ...) through the same
 * service without touching the auth/admin modules.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditEventInput) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        ipAddress: input.ipAddress ?? null,
        metadata: (input.metadata ?? null) as any,
      },
    });
  }

  /** Query the audit log with optional filters and pagination. */
  async list(filters: {
    actorUserId?: string;
    action?: AuditAction;
    entityType?: string;
    skip?: number;
    take?: number;
  }) {
    return this.prisma.auditLog.findMany({
      where: {
        actorUserId: filters.actorUserId ?? undefined,
        action: filters.action ?? undefined,
        entityType: filters.entityType ?? undefined,
      },
      orderBy: { createdAt: 'desc' },
      skip: filters.skip ?? 0,
      take: Math.min(filters.take ?? 50, 200),
      include: { actor: { select: { id: true, name: true, employeeCode: true } } },
    });
  }
}
