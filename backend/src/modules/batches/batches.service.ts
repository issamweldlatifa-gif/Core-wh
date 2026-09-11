import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { isBatchEnabled } from './batch-feature-flag';
import { BATCH_CODE_PREFIX, UNIT_CODE_PREFIX, nextBatchCode, nextUnitCode } from './batch-codes';
import { nextBatchStatus, type BatchAction, type BatchStatusValue } from './batch-status';
import {
  BatchCompleteReceivingDto,
  BatchCreateDto,
  BatchDecisionDto,
  BatchReceiveUnitDto,
  BatchSendDto,
  BatchUnitInputDto,
  BatchVoidDto,
  unitInputViolations,
} from './dto/batch-card.dto';

/** Actor shape shared with the controller (same convention as receiving). */
export interface BatchActor {
  id: string;
  name?: string | null;
  ip?: string | null;
}

const norm = (s: string) => s.trim().toUpperCase();

/**
 * AYROVI BATCH — operational service (Phase 2, slice 2).
 *
 * House rules baked in (IMPLEMENTATION COMMAND + v3 plan):
 *  - `batch.enabled` flag gates EVERY operation (absent key = OFF).
 *  - One batch = one lifecycle owner; the state machine (batch-status.ts) is
 *    the ONLY path between statuses; terminals accept nothing.
 *  - Idempotency anchors: create + add-item + submit + complete + send are
 *    replay-safe (command §5). A retried write returns the SAME result.
 *  - Every scan = ONE unit: the BatchItem status guard is the duplicate
 *    protection; the same SKU on another physical piece is a different
 *    AYROVI unit and scans again. SKU×10 = 10 items, never "a duplicate".
 *  - Concurrency reuses the shared-receiving-queue pattern: reads outside
 *    the tx, writes guarded by the exact value they were computed from
 *    (updateMany), losers surface BATCH_RACE_RETRY and the client replays
 *    with the SAME idempotency key. No new concurrency mechanism.
 *  - No real DELETE: void + audit + reason, through the EXISTING AuditService
 *    (actor/action/entity/entityId/metadata/timestamp), atomic with the
 *    mutation via tx.
 *  - This service never touches customerArrivalCardId / CRM Arrival /
 *    PRODUCT or CARTON receiving.
 */
@Injectable()
export class BatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- helpers

  /** Feature gate: while `batch.enabled` is OFF nothing batch is reachable. */
  private async assertEnabled() {
    const rows = (await this.prisma.systemSetting.findMany()) as Array<{ key: string; value: unknown }>;
    if (!isBatchEnabled(rows)) throw new ForbiddenException('BATCH_FEATURE_DISABLED');
  }

  private requireTransition(status: BatchStatusValue, action: BatchAction): BatchStatusValue {
    const to = nextBatchStatus(status, action);
    if (to === null) {
      throw new ConflictException(`FORBIDDEN_BATCH_TRANSITION: ${action} is not allowed from ${status}`);
    }
    return to;
  }

  private isP2002(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
  }

  private dayCompact(): string {
    return new Date().toISOString().slice(0, 10).replaceAll('-', '');
  }

  /**
   * ONE AyroviUnit + its BatchItem membership. The AYROVI identity (AYP-…) is
   * generated here and is independent from the original; original
   * barcode/SKU/reference are stored VERBATIM when given and NEVER invented
   * for MANUAL. Code collision under concurrency walks to the next free code.
   */
  private async createUnitInTx(
    tx: Prisma.TransactionClient,
    batch: { id: string; batchCode: string },
    input: BatchUnitInputDto,
    actor: BatchActor,
  ) {
    const violations = unitInputViolations(input);
    if (violations.length) throw new BadRequestException(violations.join('; '));

    let unit: { id: string; code: string } | null = null;
    let unitCode = '';
    for (let attempt = 0; attempt < 3 && !unit; attempt += 1) {
      const max = await tx.ayroviUnit.findFirst({
        where: { code: { startsWith: UNIT_CODE_PREFIX } },
        orderBy: { code: 'desc' },
        select: { code: true },
      });
      unitCode = nextUnitCode(max ? [max.code] : []);
      try {
        unit = await tx.ayroviUnit.create({
          data: {
            code: unitCode,
            identifierType: input.identifierType,
            originalBarcode: input.originalBarcode?.trim() || null,
            originalSku: input.originalSku?.trim() || null,
            originalReference: input.originalReference?.trim() || null,
            createdByWorkerId: actor.id,
          },
          select: { id: true, code: true },
        });
      } catch (e) {
        if (!this.isP2002(e)) throw e; // another worker took the code — walk
      }
    }
    if (!unit) throw new ConflictException('UNIT_CODE_EXHAUSTED');

    const item = await tx.batchItem.create({
      data: {
        batchId: batch.id,
        unitId: unit.id,
        identifierType: input.identifierType,
        identifierValue: input.identifierValue?.trim() || null,
        normalizedIdentifier: input.identifierValue ? norm(input.identifierValue) : null,
        status: 'REGISTERED',
        scannedByWorkerId: actor.id,
        idempotencyKey: input.idempotencyKey,
      },
    });
    return { unit, item };
  }

  // ---------------------------------------------------------------- writes

  /** Worker creates a batch (+ optional first scan) — batchCode born here. */
  async create(actor: BatchActor, dto: BatchCreateDto, depth = 0) {
    await this.assertEnabled();
    // Fail fast BEFORE anything is written (nothing persists on a bad input).
    if (dto.firstItem) {
      const violations = unitInputViolations(dto.firstItem);
      if (violations.length) throw new BadRequestException(violations.join('; '));
    }
    const replay = await this.prisma.batch.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (replay) return { batch: replay, replayed: true };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const day = this.dayCompact();
        const max = await tx.batch.findFirst({
          where: { batchCode: { startsWith: `${BATCH_CODE_PREFIX}${day}-` } },
          orderBy: { batchCode: 'desc' },
          select: { batchCode: true },
        });
        const batchCode = nextBatchCode(new Date().toISOString().slice(0, 10), max ? [max.batchCode] : []);

        // Customer is created BY THE WORKER in the app (needsReview default
        // true) and reused verbatim when the same name+externalRef reappears.
        let customer = await tx.batchCustomer.findFirst({
          where: { name: dto.customer.name.trim(), externalRef: dto.customer.externalRef?.trim() || null },
        });
        if (!customer) {
          customer = await tx.batchCustomer.create({
            data: {
              name: dto.customer.name.trim(),
              externalRef: dto.customer.externalRef?.trim() || null,
              createdByWorkerId: actor.id,
            },
          });
        }

        const batch = await tx.batch.create({
          data: {
            batchCode,
            source: 'WORKER_APP_BATCH',
            status: 'CREATED',
            totalExpected: dto.firstItem ? 1 : 0,
            totalScanned: 0,
            customerId: customer.id,
            createdById: actor.id,
            idempotencyKey: dto.idempotencyKey,
          },
        });
        const first = dto.firstItem ? await this.createUnitInTx(tx, batch, dto.firstItem, actor) : null;
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'BATCH_CREATED' as never,
            entityType: 'batch',
            entityId: batch.id,
            ipAddress: actor.ip ?? null,
            metadata: { batchCode, customerId: customer.id, firstUnit: first?.unit.code ?? null },
          },
          tx,
        );
        return { batch, customer, first, replayed: false };
      });
    } catch (e) {
      // Two devices racing the SAME create key: exactly one insert wins —
      // the loser replays the winner's batch. A batchCode P2002 (impossible
      // day-sequence clash) retries the whole create once with fresh state.
      if (this.isP2002(e)) {
        const winner = await this.prisma.batch.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (winner) return { batch: winner, replayed: true };
        if (depth < 1) return this.create(actor, dto, depth + 1);
      }
      throw e;
    }
  }

  /** Worker adds ONE physical unit. Replay with the SAME key = SAME item. */
  async addUnit(actor: BatchActor, batchId: string, input: BatchUnitInputDto) {
    await this.assertEnabled();
    const replay = await this.prisma.batchItem.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { unit: true },
    });
    if (replay) {
      if (replay.batchId !== batchId) throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      return { item: replay, unit: replay.unit, replayed: true };
    }

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      if (batch.status !== 'CREATED') {
        throw new ConflictException('BATCH_NOT_EDITABLE: units can only be added while CREATED');
      }
      const created = await this.createUnitInTx(tx, batch, input, actor);
      // Optimistic increment (shared queue: two devices may add in parallel).
      // Guarded by the value we read; a loser throws and the tx rolls the
      // unit+item back — the client replays with the SAME idempotency key.
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, totalExpected: batch.totalExpected },
        data: { totalExpected: { increment: 1 } },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_RACE_RETRY');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_UNIT_ADDED' as never,
          entityType: 'batch_item',
          entityId: created.item.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, unitCode: created.unit.code, identifierType: input.identifierType },
        },
        tx,
      );
      return { ...created, replayed: false };
    });
  }

  /** Worker submits the built batch — CREATED → SUBMITTED, replay-safe. */
  async submit(actor: BatchActor, batchId: string, dto: { idempotencyKey: string; note?: string }) {
    await this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      if (batch.submitIdempotencyKey === dto.idempotencyKey) {
        if (batch.status === 'SUBMITTED') return { batch, replayed: true };
        throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      }
      if (batch.totalExpected < 1) throw new ConflictException('BATCH_EMPTY: submit needs at least one unit');
      const to = this.requireTransition(batch.status, 'submit');
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status, submitIdempotencyKey: null },
        data: { status: to, submittedAt: new Date(), submitIdempotencyKey: dto.idempotencyKey },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_STATE_CHANGED');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_SUBMITTED' as never,
          entityType: 'batch',
          entityId: batch.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, units: batch.totalExpected, note: dto.note ?? null },
        },
        tx,
      );
      return { batch: { ...batch, status: to }, replayed: false };
    });
  }

  /** Admin accepts — SUBMITTED → ACCEPTED (attribution via operatorId). */
  async accept(actor: BatchActor, batchId: string, dto: BatchDecisionDto) {
    await this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      const to = this.requireTransition(batch.status, 'accept');
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status },
        data: { status: to, acceptedAt: new Date(), acceptedById: dto.operatorId },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_STATE_CHANGED');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_ACCEPTED' as never,
          entityType: 'batch',
          entityId: batch.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, operatorId: dto.operatorId, reason: dto.reason ?? null },
        },
        tx,
      );
      return { batch: { ...batch, status: to }, replayed: false };
    });
  }

  /** Admin sends to receiving — ACCEPTED → SENT_TO_RECEIVING, replay-safe. */
  async send(actor: BatchActor, batchId: string, dto: BatchSendDto) {
    await this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      if (batch.sendIdempotencyKey === dto.idempotencyKey) {
        if (batch.status === 'SENT_TO_RECEIVING') return { batch, replayed: true };
        throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      }
      const to = this.requireTransition(batch.status, 'send');
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status, sendIdempotencyKey: null },
        data: { status: to, sentAt: new Date(), sentById: dto.operatorId, sendIdempotencyKey: dto.idempotencyKey },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_STATE_CHANGED');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_SENT_TO_RECEIVING' as never,
          entityType: 'batch',
          entityId: batch.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, operatorId: dto.operatorId, reason: dto.reason ?? null },
        },
        tx,
      );
      return { batch: { ...batch, status: to }, replayed: false };
    });
  }

  /** Receiving station opens the batch — SENT_TO_RECEIVING → IN_PROGRESS. */
  async startReceiving(actor: BatchActor, batchId: string) {
    await this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      const to = this.requireTransition(batch.status, 'startReceiving');
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status },
        data: { status: to },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_STATE_CHANGED');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_RECEIVING_STARTED' as never,
          entityType: 'batch',
          entityId: batch.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode },
        },
        tx,
      );
      return { batch: { ...batch, status: to }, replayed: false };
    });
  }

  /**
   * ONE scan = ONE unit. The item status guard is the duplicate protection:
   * re-reading the SAME label answers alreadyReceived (never double counts),
   * while the SAME SKU on another piece is a DIFFERENT unit code.
   */
  async receiveUnit(actor: BatchActor, batchId: string, dto: BatchReceiveUnitDto) {
    await this.assertEnabled();
    const code = dto.unitCode.trim();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      if (batch.status !== 'RECEIVING_IN_PROGRESS') {
        throw new ConflictException('BATCH_RECEIVING_NOT_STARTED');
      }
      const unit = await tx.ayroviUnit.findUnique({ where: { code }, include: { batchItems: true } });
      if (!unit) throw new NotFoundException('UNIT_NOT_FOUND');
      const item = unit.batchItems.find((i) => i.batchId === batchId);
      if (!item) throw new ConflictException('UNIT_NOT_IN_THIS_BATCH');
      if (item.status === 'RECEIVED') {
        return {
          unitCode: unit.code,
          alreadyReceived: true,
          totalScanned: batch.totalScanned,
          totalExpected: batch.totalExpected,
        };
      }
      const applied = await tx.batchItem.updateMany({
        where: { id: item.id, status: 'REGISTERED' },
        data: { status: 'RECEIVED' },
      });
      if (applied.count === 0) {
        // Lost the per-item race — same outcome as an echo read.
        return {
          unitCode: unit.code,
          alreadyReceived: true,
          totalScanned: batch.totalScanned,
          totalExpected: batch.totalExpected,
        };
      }
      // Optimistic counter guard (several workers scan the same batch).
      // Throw rolls the receipt back too (atomic) — the client replays.
      const counted = await tx.batch.updateMany({
        where: { id: batch.id, totalScanned: batch.totalScanned },
        data: { totalScanned: { increment: 1 } },
      });
      if (counted.count === 0) throw new ConflictException('BATCH_RACE_RETRY');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_UNIT_RECEIVED' as never,
          entityType: 'batch_item',
          entityId: item.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, unitCode: unit.code, identifierType: item.identifierType },
        },
        tx,
      );
      return {
        unitCode: unit.code,
        alreadyReceived: false,
        totalScanned: batch.totalScanned + 1,
        totalExpected: batch.totalExpected,
      };
    });
  }

  /** Receiving complete — REQUIRES 10/10 (all units RECEIVED, counts equal). */
  async completeReceiving(actor: BatchActor, batchId: string, dto: BatchCompleteReceivingDto) {
    await this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      if (batch.completeReceivingIdempotencyKey === dto.idempotencyKey) {
        if (batch.status === 'RECEIVING_COMPLETED') return { batch, replayed: true };
        throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      }
      const missing = await tx.batchItem.count({ where: { batchId, status: 'REGISTERED' } });
      if (missing > 0) {
        throw new ConflictException(`BATCH_RECEIVING_INCOMPLETE: ${missing} unit(s) not received`);
      }
      if (batch.totalScanned !== batch.totalExpected) {
        throw new ConflictException('BATCH_COUNT_MISMATCH');
      }
      const to = this.requireTransition(batch.status, 'completeReceiving');
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status, completeReceivingIdempotencyKey: null },
        data: { status: to, completedAt: new Date(), completeReceivingIdempotencyKey: dto.idempotencyKey },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_STATE_CHANGED');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_RECEIVING_COMPLETED' as never,
          entityType: 'batch',
          entityId: batch.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, units: batch.totalExpected },
        },
        tx,
      );
      return { batch: { ...batch, status: to }, replayed: false };
    });
  }

  /** VOID + audit + reason — there is NO real DELETE in the batch system. */
  async voidBatch(actor: BatchActor, batchId: string, dto: BatchVoidDto) {
    await this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
      const to = this.requireTransition(batch.status, 'void');
      const applied = await tx.batch.updateMany({
        where: { id: batch.id, status: batch.status },
        data: { status: to, voidedAt: new Date(), voidedById: dto.operatorId, voidReason: dto.reason },
      });
      if (applied.count === 0) throw new ConflictException('BATCH_STATE_CHANGED');
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'BATCH_VOIDED' as never,
          entityType: 'batch',
          entityId: batch.id,
          ipAddress: actor.ip ?? null,
          metadata: { batchCode: batch.batchCode, operatorId: dto.operatorId, reason: dto.reason },
        },
        tx,
      );
      return { batch: { ...batch, status: to }, replayed: false };
    });
  }

  // ---------------------------------------------------------------- reads

  async list(filter: { status?: string }) {
    await this.assertEnabled();
    return this.prisma.batch.findMany({
      where: filter.status ? { status: filter.status as never } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { customer: true, _count: { select: { items: true } } },
    });
  }

  async get(batchId: string) {
    await this.assertEnabled();
    const batch = await this.prisma.batch.findUnique({
      where: { id: batchId },
      include: { customer: true, items: { include: { unit: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!batch) throw new NotFoundException('BATCH_NOT_FOUND');
    return batch;
  }
}
