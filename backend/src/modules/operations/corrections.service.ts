import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CorrectionAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Audited corrections (spec §7/§8/§39).
 *
 * Hard rules enforced here, not in the UI:
 *   1. Operational history is NEVER overwritten. Every correction captures an
 *      immutable `originalSnapshot` and `newSnapshot`.
 *   2. A reason is mandatory and non-trivial.
 *   3. Corrections only run through these controlled operations — there is no
 *      generic "edit this row" path anywhere in the system (§7).
 *   4. Reversing a receipt does NOT delete the receipt event; it marks the
 *      carton back to EXPECTED and records the reversal, so the original
 *      receipt stays visible in the session timeline.
 */
export interface CorrectionActor {
  id: string;
  ip?: string;
  permissions: string[];
}

const MIN_REASON = 8;

/** Which permission each correction action demands (§9/§41). */
const ACTION_PERMISSION: Record<CorrectionAction, string> = {
  REVERSE_RECEIVING: 'operations.correct',
  CORRECT_PRODUCT: 'operations.correct',
  CORRECT_QUANTITY: 'operations.correct',
  REASSIGN_SESSION: 'operations.correct',
  REOPEN_SESSION: 'operations.correct',
  VOID_OPERATION: 'operations.correct',
  RESOLVE_EXCEPTION: 'operations.correct',
};

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertAllowed(action: CorrectionAction, actor: CorrectionActor) {
    const needed = ACTION_PERMISSION[action];
    if (!actor.permissions.includes(needed)) {
      throw new ForbiddenException(`Missing permission "${needed}" for ${action}.`);
    }
  }

  private assertReason(reason: string) {
    if (!reason || reason.trim().length < MIN_REASON) {
      throw new BadRequestException(`A correction reason of at least ${MIN_REASON} characters is required.`);
    }
  }

  private async nextCode(tx: Prisma.TransactionClient) {
    const count = await tx.operationCorrection.count();
    return `COR-${String(count + 1).padStart(6, '0')}`;
  }

  async list(filter?: { sessionId?: string; entityId?: string; take?: number }) {
    return this.prisma.operationCorrection.findMany({
      where: {
        receivingSessionId: filter?.sessionId ?? undefined,
        entityId: filter?.entityId ?? undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter?.take ?? 100, 200),
      include: {
        admin: { select: { id: true, name: true, employeeCode: true } },
        worker: { select: { id: true, name: true, employeeCode: true } },
        session: { select: { id: true, code: true } },
      },
    });
  }

  /**
   * Reverse a previously received carton.
   * The receipt row is retained and marked REVERSED — never deleted (§8).
   */
  async reverseCarton(receivingCartonId: string, reason: string, actor: CorrectionActor) {
    this.assertAllowed('REVERSE_RECEIVING', actor);
    this.assertReason(reason);

    const rc = await this.prisma.receivingCarton.findUnique({
      where: { id: receivingCartonId },
      include: { carton: true, session: true },
    });
    if (!rc) throw new NotFoundException('Receiving carton record not found.');
    if (rc.status !== 'RECEIVED') throw new BadRequestException('Only a RECEIVED carton can be reversed.');

    const originalSnapshot = {
      receivingCartonId: rc.id,
      cartonId: rc.cartonId,
      scannedCode: rc.scannedCode,
      status: rc.status,
      source: rc.source,
      receivedBy: rc.receivedBy,
      receivedAt: rc.receivedAt,
      cartonStatus: rc.carton?.status ?? null,
    };

    return this.prisma.$transaction(async (tx) => {
      await tx.receivingCarton.update({
        where: { id: rc.id },
        data: { status: 'REVERSED' as never },
      });
      if (rc.cartonId) {
        await tx.warehouseCarton.update({
          where: { id: rc.cartonId },
          data: { status: 'EXPECTED', receivedAt: null, receivedBy: null },
        });
      }

      const newSnapshot = {
        receivingCartonId: rc.id,
        status: 'REVERSED',
        cartonStatus: 'EXPECTED',
        reversedBy: actor.id,
        reversedAt: new Date().toISOString(),
      };

      const correction = await tx.operationCorrection.create({
        data: {
          code: await this.nextCode(tx),
          action: 'REVERSE_RECEIVING',
          reason: reason.trim(),
          adminId: actor.id,
          ipAddress: actor.ip ?? null,
          entityType: 'receiving_carton',
          entityId: rc.id,
          receivingSessionId: rc.receivingSessionId,
          workerId: rc.receivedBy ?? null,
          originalSnapshot: originalSnapshot as unknown as Prisma.InputJsonValue,
          newSnapshot: newSnapshot as unknown as Prisma.InputJsonValue,
        },
      });

      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'RECEIVING_REVERSED' as never,
          entityType: 'receiving_carton',
          entityId: rc.id,
          ipAddress: actor.ip ?? null,
          metadata: { correction: correction.code, carton: rc.scannedCode, reason: reason.trim() },
        },
        tx,
      );
      return correction;
    });
  }

  /** Correct the received quantity on a product line, keeping the original. */
  async correctQuantity(
    receivingProductId: string,
    newQuantity: number,
    reason: string,
    actor: CorrectionActor,
  ) {
    this.assertAllowed('CORRECT_QUANTITY', actor);
    this.assertReason(reason);
    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      throw new BadRequestException('newQuantity must be a non-negative integer.');
    }

    const rp = await this.prisma.receivingProduct.findUnique({ where: { id: receivingProductId } });
    if (!rp) throw new NotFoundException('Receiving product record not found.');

    const originalSnapshot = {
      receivingProductId: rp.id,
      sku: rp.sku,
      receivedQuantity: rp.receivedQuantity,
      expectedQuantity: rp.expectedQuantity,
      status: rp.status,
    };

    return this.prisma.$transaction(async (tx) => {
      const expected = rp.expectedQuantity ?? 0;
      const status =
        newQuantity === 0
          ? 'EXPECTED'
          : newQuantity < expected
            ? 'PARTIALLY_RECEIVED'
            : newQuantity > expected
              ? 'OVERAGE'
              : 'RECEIVED';

      const saved = await tx.receivingProduct.update({
        where: { id: rp.id },
        // `difference` is denormalised on the row, so it must move with the
        // quantity or the reconciliation totals would silently drift.
        data: {
          receivedQuantity: newQuantity,
          difference: newQuantity - expected,
          status: status as never,
        },
      });

      const correction = await tx.operationCorrection.create({
        data: {
          code: await this.nextCode(tx),
          action: 'CORRECT_QUANTITY',
          reason: reason.trim(),
          adminId: actor.id,
          ipAddress: actor.ip ?? null,
          entityType: 'receiving_product',
          entityId: rp.id,
          receivingSessionId: rp.receivingSessionId,
          originalSnapshot: originalSnapshot as unknown as Prisma.InputJsonValue,
          newSnapshot: {
            receivingProductId: saved.id,
            sku: saved.sku,
            receivedQuantity: saved.receivedQuantity,
            status: saved.status,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CORRECTION_APPLIED' as never,
          entityType: 'receiving_product',
          entityId: rp.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            correction: correction.code,
            sku: rp.sku,
            from: rp.receivedQuantity,
            to: newQuantity,
            reason: reason.trim(),
          },
        },
        tx,
      );
      return correction;
    });
  }

  /** Resolve an exception/discrepancy with a mandatory, audited reason. */
  async resolveException(discrepancyId: string, resolution: string, reason: string, actor: CorrectionActor) {
    this.assertAllowed('RESOLVE_EXCEPTION', actor);
    this.assertReason(reason);

    const d = await this.prisma.receivingDiscrepancy.findUnique({ where: { id: discrepancyId } });
    if (!d) throw new NotFoundException('Discrepancy not found.');
    if (d.status !== 'OPEN') throw new BadRequestException('Only an OPEN discrepancy can be resolved.');

    const originalSnapshot = {
      discrepancyId: d.id,
      type: d.type,
      status: d.status,
      expectedQuantity: d.expectedQuantity,
      actualQuantity: d.actualQuantity,
      reason: d.reason,
    };

    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.receivingDiscrepancy.update({
        where: { id: d.id },
        data: {
          status: 'RESOLVED',
          resolvedBy: actor.id,
          resolvedAt: new Date(),
          resolution: resolution?.trim() || reason.trim(),
        },
      });

      const correction = await tx.operationCorrection.create({
        data: {
          code: await this.nextCode(tx),
          action: 'RESOLVE_EXCEPTION',
          reason: reason.trim(),
          adminId: actor.id,
          ipAddress: actor.ip ?? null,
          entityType: 'receiving_discrepancy',
          entityId: d.id,
          receivingSessionId: d.receivingSessionId,
          originalSnapshot: originalSnapshot as unknown as Prisma.InputJsonValue,
          newSnapshot: {
            discrepancyId: saved.id,
            status: saved.status,
            resolution: saved.resolution,
            resolvedBy: actor.id,
            resolvedAt: saved.resolvedAt,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'DISCREPANCY_RESOLVED' as never,
          entityType: 'receiving_discrepancy',
          entityId: d.id,
          ipAddress: actor.ip ?? null,
          metadata: { correction: correction.code, type: d.type, reason: reason.trim() },
        },
        tx,
      );
      return correction;
    });
  }

  /** Reopen a completed session so work can continue, with an audit trail. */
  async reopenSession(sessionId: string, reason: string, actor: CorrectionActor) {
    this.assertAllowed('REOPEN_SESSION', actor);
    this.assertReason(reason);

    const s = await this.prisma.receivingSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Session not found.');
    if (s.status === 'RECEIVING') throw new BadRequestException('Session is already open.');

    const originalSnapshot = {
      sessionId: s.id,
      code: s.code,
      status: s.status,
      completedAt: s.completedAt,
      completedBy: s.completedBy,
    };

    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.receivingSession.update({
        where: { id: s.id },
        data: { status: 'RECEIVING', completedAt: null, completedBy: null },
      });

      const correction = await tx.operationCorrection.create({
        data: {
          code: await this.nextCode(tx),
          action: 'REOPEN_SESSION',
          reason: reason.trim(),
          adminId: actor.id,
          ipAddress: actor.ip ?? null,
          entityType: 'receiving_session',
          entityId: s.id,
          receivingSessionId: s.id,
          workerId: s.startedBy ?? null,
          originalSnapshot: originalSnapshot as unknown as Prisma.InputJsonValue,
          newSnapshot: { sessionId: saved.id, status: saved.status } as unknown as Prisma.InputJsonValue,
        },
      });

      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'SESSION_REOPENED' as never,
          entityType: 'receiving_session',
          entityId: s.id,
          ipAddress: actor.ip ?? null,
          metadata: { correction: correction.code, session: s.code, reason: reason.trim() },
        },
        tx,
      );
      return correction;
    });
  }
}
