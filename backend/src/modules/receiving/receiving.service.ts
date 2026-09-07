import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { TaskDispatchService } from '../assignments/dispatch.service';
import { normalizeScan, sameScanCode, OPERATIONAL_ERRORS } from '../../common/scan-normalizer';

const RCV_PREFIX = 'RCV-';
const RCV_START = 200;

export interface ReceivingActor {
  id: string;
  name?: string;
  // role-derived capability flag (resolve via permissions guard upstream).
  canResolveDiscrepancy?: boolean;
  ip?: string | null;
}

export interface StartOpts {
  deviceType?: string | null;
  deviceName?: string | null;
  scanSource?: string | null;
}

export type CardType = 'PRODUCT' | 'CARTON';
export type IdentifierType = 'QR' | 'BARCODE' | 'OCR' | 'MANUAL';

export interface CardConfirmInput {
  identifier: string;
  identifierType?: IdentifierType;
  source?: string;
  operationId?: string;
  /** Device-side matching start (ISO date) — used for the operation duration. */
  startedAt?: string;
}

export interface ProductConfirmInput extends CardConfirmInput {
  quantity?: number;
}

export interface MismatchInput {
  cardType: CardType;
  identifier: string;
  identifierType?: IdentifierType;
  source?: string;
  startedAt?: string;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const SCAN_SOURCES = ['CAMERA', 'EXTERNAL_SCANNER', 'MANUAL'] as const;
/** The DB enum only knows 3 sources; unknown/missing input degrades to MANUAL (never a failed scan). */
function scanSourceOf(source: string | undefined): typeof SCAN_SOURCES[number] {
  return SCAN_SOURCES.find((s) => s === (source ?? '').trim().toUpperCase()) ?? 'MANUAL';
}

/**
 * Station the worker is physically standing at (§13).
 *
 * Resolved from the station assignment rather than trusted from the client:
 * the terminal must not be able to claim it is somewhere it is not, because
 * this value is later used for per-station operational reporting.
 */
async function resolveStationId(
  tx: Prisma.TransactionClient,
  workerId: string | null | undefined,
): Promise<string | null> {
  if (!workerId) return null;
  const station = await tx.station.findFirst({
    where: { assignedWorkerId: workerId, status: 'ACTIVE' },
    select: { id: true },
  });
  return station?.id ?? null;
}

/** Expected card data held by the worker device for DEVICE-SIDE MATCHING. */
export interface ProductCard {
  id: string;
  sku: string | null;
  reference: string | null;
  productName: string | null;
  category: string | null;
  subcategory: string | null;
  categoryStatus: string;
  expected: number;
  received: number;
  remaining: number;
  status: string;
  /** Normalized (uppercased) comparison keys the device may match against. */
  identifiers: string[];
}

export interface CartonCard {
  id: string;
  externalCartonId: string;
  reference: string | null;
  qrCodeValue: string | null;
  barcodeValue: string | null;
  cartonNumber: number;
  totalCartons: number;
  /** Shipment-level card data (CRM Shipment Card). */
  trackingNumber: string | null;
  senderName: string | null;
  shippedAt: string | null;
  weight: number | null;
  weightUnit: string | null;
  dimensions: { length: number | null; width: number | null; height: number | null; unit: string | null } | null;
  status: string;
  /** Normalized (uppercased) comparison keys the device may match against. */
  identifiers: string[];
}

function cardIdentifiers(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    const n = normalizeScan(v ?? '').toUpperCase();
    if (n.length >= 2 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Receiving — card-based physical receipt (device-side matching rebuild).
 *
 * The CRM pushes two INDEPENDENT card types (Customer Arrival Card ->
 * product cards, Shipment Card -> carton cards). The worker device downloads
 * the expected card data with the session and matches scanned identifiers
 * locally; the backend stays authoritative for synchronization, persistence,
 * final validation, state update, duplicate/conflict protection and the
 * worker activity log (ReceivingWorkerLog).
 *
 * Integrity rule: expected data is IMMUTABLE here. Receiving writes its own
 * observation rows (ReceivingCarton / ReceivingProduct / ReceivingDiscrepancy
 * / ReceivingWorkerLog) and never overwrites expected card data.
 */
@Injectable()
export class ReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly assignments: AssignmentsService,
    private readonly dispatch: TaskDispatchService,
  ) {}

  // ---------- helpers ----------
  private async genCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.receivingSession.count();
      const code = `${RCV_PREFIX}${String(RCV_START + count + 1).padStart(6, '0')}`;
      if (!(await tx.receivingSession.findUnique({ where: { code } }))) return code;
    }
    return `${RCV_PREFIX}R${Date.now().toString().slice(-6)}`;
  }

  /**
   * Persistent worker activity log row (Admin "Receiving Worker" report):
   * Who / What / When / Card / Card Type / Operation / Identifier / Result /
   * Duration / Device. Written through the caller's transaction so the log
   * and the state change commit atomically.
   */
  private async logWorker(
    tx: Prisma.TransactionClient,
    session: { id: string; code: string; deviceType: string | null; deviceName: string | null },
    actor: ReceivingActor,
    input: {
      cardType: CardType;
      cardRef?: string | null;
      operation: 'CONFIRM' | 'SCAN_REJECT' | 'DUPLICATE_REJECT';
      identifierType: IdentifierType;
      source: string;
      identifierValue: string;
      result: 'MATCH' | 'MISMATCH' | 'DUPLICATE' | 'AMBIGUOUS';
      startedAt: Date | null;
      arrivalCode?: string | null;
    },
  ) {
    const endedAt = new Date();
    const startedAt = input.startedAt ?? endedAt;
    return tx.receivingWorkerLog.create({
      data: {
        receivingSessionId: session.id,
        workerId: actor.id,
        workerName: actor.name ?? null,
        taskKey: 'receiving',
        arrivalCode: input.arrivalCode ?? null,
        sessionCode: session.code,
        cardType: input.cardType,
        cardRef: input.cardRef ?? null,
        operation: input.operation,
        identifierType: input.identifierType as never,
        source: input.source,
        identifierValue: input.identifierValue,
        result: input.result,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        deviceType: session.deviceType ?? null,
        deviceName: session.deviceName ?? null,
      },
    });
  }

  // ---------- start ----------
  async start(arrivalIdOrCode: string, actor: ReceivingActor, opts: StartOpts = {}) {
    const arrival = await this.prisma.expectedArrival.findFirst({
      where: { OR: [{ id: arrivalIdOrCode }, { code: arrivalIdOrCode }] },
      include: {
        items: true,
        shipments: { where: {}, include: { cartons: true } },
      },
    });
    if (!arrival) throw new NotFoundException('Expected arrival not found.');
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: arrival.id });
    if (arrival.status === 'RECEIVED' || arrival.status === 'RECEIVED_WITH_DISCREPANCY') {
      throw new ConflictException('This arrival is already received.');
    }

    // 1 active (RECEIVING/PAUSED) session per arrival.
    const active = await this.prisma.receivingSession.findFirst({
      where: { arrivalId: arrival.id, status: { in: ['RECEIVING', 'PAUSED'] } },
    });
    if (active) return this.sessionDetail(active.id);

    const primaryShipment = arrival.shipments[0] ?? null;
    return this.prisma.$transaction(async (tx) => {
      const code = await this.genCode(tx);
      const stationId = await resolveStationId(tx, actor.id);
      const session = await tx.receivingSession.create({
        data: {
          code,
          arrivalId: arrival.id,
          shipmentId: primaryShipment?.id ?? null,
          status: 'RECEIVING',
          startedBy: actor.id,
          startedAt: new Date(),
          deviceType: opts.deviceType ?? null,
          deviceName: opts.deviceName ?? null,
          scanSource: opts.scanSource ?? null,
          stationId,
        },
      });
      // Seed the expected PRODUCT CARDS from the Customer Arrival Card lines.
      // Every card stays independent; the CARTON lane only ever sees carton
      // cards (Shipment Card data) — the two card sets are never merged.
      type Agg = {
        qty: number; name: string; ref: string | null; itemId: string;
        category: string | null; subcategory: string | null;
        categoryStatus: 'CONFIRMED' | 'NEEDS_REVIEW';
      };
      const lines: Record<string, Agg> = {};
      for (const it of arrival.items) {
        const key = it.sku || it.reference || '';
        if (!key) {
          // Product card has no usable identifier -> needs review.
          await tx.receivingProduct.create({
            data: {
              receivingSessionId: session.id, arrivalItemId: it.id, sku: null, reference: it.reference,
              productName: it.productName, category: it.category ?? null,
              subcategory: it.subcategory ?? null,
              categoryStatus: (it.categoryStatus ?? 'NEEDS_REVIEW') as never,
              expectedQuantity: it.quantity, receivedQuantity: 0,
              difference: -it.quantity, status: 'NEEDS_REVIEW',
            },
          });
          continue;
        }
        const norm = key.trim();
        if (!lines[norm]) {
          lines[norm] = {
            qty: 0, name: it.productName || '', ref: it.reference, itemId: it.id,
            category: it.category ?? null, subcategory: it.subcategory ?? null,
            categoryStatus: (it.categoryStatus ?? 'NEEDS_REVIEW') as Agg['categoryStatus'],
          };
        }
        lines[norm].qty += it.quantity;
        // Same SKU should carry one category; if CRM lines disagree we keep
        // the first non-null value rather than guessing. A single
        // NEEDS_REVIEW line taints the aggregate (never over-claim CONFIRMED).
        if (!lines[norm].category && it.category) lines[norm].category = it.category;
        if (!lines[norm].subcategory && it.subcategory) lines[norm].subcategory = it.subcategory;
        if ((it.categoryStatus ?? 'NEEDS_REVIEW') === 'NEEDS_REVIEW') lines[norm].categoryStatus = 'NEEDS_REVIEW';
      }
      for (const [sku, agg] of Object.entries(lines)) {
        await tx.receivingProduct.create({
          data: {
            receivingSessionId: session.id, arrivalItemId: agg.itemId, sku, reference: agg.ref,
            productName: agg.name, category: agg.category,
            subcategory: agg.subcategory, categoryStatus: agg.categoryStatus as never,
            expectedQuantity: agg.qty, receivedQuantity: 0,
            difference: -agg.qty, status: 'EXPECTED',
          },
        });
      }
      await tx.expectedArrival.update({ where: { id: arrival.id }, data: { status: 'RECEIVING' } });
      await this.audit.log({
        actorUserId: actor.id, action: 'RECEIVING_STARTED' as never, entityType: 'receiving_session',
        entityId: session.id, ipAddress: actor.ip ?? null,
        metadata: { session: code, arrival: arrival.code, shipment: primaryShipment?.code ?? null },
      }, tx);
      await this.assignments.receivingStarted(arrival.id, code, actor.id, tx);
      return session;
    }).then((s) => this.sessionDetail(s.id));
  }

  // ---------- PRODUCT lane: confirm a product card (device-side match) ----------
  /**
   * PRODUCT card confirmation. The device already matched the scanned
   * identifier against its local product cards; the backend re-validates
   * (final authority), persists the receipt, logs the worker activity and
   * guards against duplicate completion. A mismatch NEVER confirms and is
   * logged as a failure.
   */
  async confirmProduct(sessionId: string, input: ProductConfirmInput, actor: ReceivingActor) {
    const session = await this.requireConfirmableSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    const term = normalizeScan(input.identifier);
    if (!term) throw new BadRequestException(OPERATIONAL_ERRORS.productNotMatched);
    const qty = Math.max(1, Math.floor(Number(input.quantity) || 1));
    const identifierType = (input.identifierType ?? 'MANUAL') as IdentifierType;
    const source = input.source ?? 'MANUAL';
    const startedAt = parseDate(input.startedAt);

    // C-4 idempotency: a client operationId (device-generated, stable across
    // retries) is processed exactly once. Replays return the current session
    // state without creating a second observation or a second log row.
    if (input.operationId) {
      const dup = await this.prisma.receivingScanEvent.findUnique({ where: { operationId: input.operationId } });
      if (dup && dup.sessionId === sessionId) return this.sessionDetail(sessionId);
      if (dup) throw new ConflictException('This operation was already applied to another session.');
    }

    // FINAL server-side match against this session's PRODUCT cards (SKU or
    // reference, case-insensitive). The device match is advisory only.
    const line = await this.prisma.receivingProduct.findFirst({
      where: {
        receivingSessionId: sessionId,
        OR: [
          { sku: { equals: term, mode: 'insensitive' } },
          { reference: { equals: term, mode: 'insensitive' } },
        ],
      },
    });

    if (!line) {
      // MISMATCH — DO NOT CONFIRM, DO NOT COMPLETE, LOG FAILURE.
      await this.prisma.$transaction(async (tx) => {
        const log = await this.logWorker(tx, session, actor, {
          cardType: 'PRODUCT', operation: 'CONFIRM', identifierType, source,
          identifierValue: term, result: 'MISMATCH', startedAt,
        });
        await this.audit.log({
          actorUserId: actor.id, action: 'UNEXPECTED_PRODUCT' as never, entityType: 'receiving_worker_log',
          entityId: log.id, ipAddress: actor.ip ?? null,
          metadata: { session: session.code, identifier: term, identifierType, source, cardType: 'PRODUCT' },
        }, tx);
      });
      return this.sessionDetail(sessionId, {
        flash: { kind: 'MISMATCH', cardType: 'PRODUCT', code: term, message: OPERATIONAL_ERRORS.productNotMatched },
      });
    }

    // Completed card -> REJECT (duplicate completion protection).
    if (line.receivedQuantity >= line.expectedQuantity) {
      const ref = line.sku ?? line.reference ?? term;
      await this.prisma.$transaction(async (tx) => {
        const log = await this.logWorker(tx, session, actor, {
          cardType: 'PRODUCT', cardRef: ref, operation: 'DUPLICATE_REJECT', identifierType, source,
          identifierValue: term, result: 'DUPLICATE', startedAt,
        });
        await this.audit.log({
          actorUserId: actor.id, action: 'CARD_ALREADY_COMPLETED' as never, entityType: 'receiving_product',
          entityId: line.id, ipAddress: actor.ip ?? null,
          metadata: { card: ref, received: line.receivedQuantity, expected: line.expectedQuantity, logId: log.id },
        }, tx);
      });
      return this.sessionDetail(sessionId, {
        flash: { kind: 'CARD_ALREADY_COMPLETE', cardType: 'PRODUCT', code: ref, message: OPERATIONAL_ERRORS.productAlreadyComplete },
      });
    }

    // MATCH — persist the receipt (one physical unit per scan on devices).
    const received = line.receivedQuantity + qty;
    const difference = received - line.expectedQuantity;
    const status = received === line.expectedQuantity ? 'RECEIVED' : received > line.expectedQuantity ? 'OVERAGE' : 'PARTIALLY_RECEIVED';
    const ref = line.sku ?? line.reference ?? term;
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingProduct.update({
        where: { id: line.id },
        data: { receivedQuantity: received, difference, status: status as any },
      });
      if (input.operationId) {
        await tx.receivingScanEvent.create({ data: {
          sessionId, operationId: input.operationId, kind: 'PRODUCT', code: term, quantity: qty, source,
        } });
      }
      if (status === 'OVERAGE') {
        await tx.receivingDiscrepancy.create({ data: {
          receivingSessionId: sessionId, receivingProductId: line.id, type: 'OVERAGE',
          expectedQuantity: line.expectedQuantity, actualQuantity: received, difference,
          reason: `Overage on ${term} (+${difference})`, status: 'OPEN', createdBy: actor.id,
        } });
      }
      const log = await this.logWorker(tx, session, actor, {
        cardType: 'PRODUCT', cardRef: ref, operation: 'CONFIRM', identifierType, source,
        identifierValue: term, result: 'MATCH', startedAt,
      });
      await this.audit.log({
        actorUserId: actor.id, action: 'PRODUCT_RECEIVED' as never, entityType: 'receiving_product',
        entityId: line.id, ipAddress: actor.ip ?? null,
        metadata: { card: ref, received, expected: line.expectedQuantity, added: qty, identifierType, source, logId: log.id },
      }, tx);
    });
    return this.sessionDetail(sessionId, {
      flash: { kind: 'MATCH', cardType: 'PRODUCT', code: ref, sku: term, expected: line.expectedQuantity, received },
    });
  }

  // ---------- CARTON lane: confirm a carton card (device-side match) ----------
  /**
   * CARTON card confirmation. Matching uses the identifiers present in the
   * Carton Card: carton reference / external id / QR / barcode, plus the
   * shipment-level TRACKING number. Tracking matches resolve to the
   * shipment's cartons: exactly one open carton is confirmed, an all-received
   * shipment is rejected as complete, several open cartons are AMBIGUOUS
   * (the worker scans the specific carton). A mismatch NEVER confirms and is
   * logged as a failure.
   */
  async confirmCarton(sessionId: string, input: CardConfirmInput, actor: ReceivingActor) {
    const session = await this.requireConfirmableSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    const term = normalizeScan(input.identifier);
    if (!term) throw new BadRequestException(OPERATIONAL_ERRORS.cartonUnknown);
    const identifierType = (input.identifierType ?? 'MANUAL') as IdentifierType;
    const source = input.source ?? 'MANUAL';
    const startedAt = parseDate(input.startedAt);

    // Idempotency: the same physical carton confirmation is processed once.
    if (input.operationId) {
      const dup = await this.prisma.receivingCarton.findUnique({ where: { operationId: input.operationId } });
      if (dup && dup.receivingSessionId === sessionId) return this.sessionDetail(sessionId);
      if (dup) throw new ConflictException('This operation was already applied to another session.');
    }

    // Carton cards of THIS arrival (every shipment) with shipment context.
    const arrival = await this.prisma.expectedArrival.findUnique({
      where: { id: session.arrivalId },
      include: { shipments: { include: { cartons: true } } },
    });
    if (!arrival) throw new NotFoundException('Expected arrival not found.');
    const cards: Array<Prisma.WarehouseCartonGetPayload<{ include: { shipment: true } }> & { shipment: any }> = [];
    for (const s of arrival.shipments) {
      for (const c of s.cartons) cards.push({ ...c, shipmentId: c.shipmentId ?? s.id, shipment: s });
    }

    // 1) Carton-card identifier match (external id / reference / QR / barcode).
    let carton = cards.find(
      (c) => sameScanCode(term, c.externalCartonId) || sameScanCode(term, c.cartonReference)
        || sameScanCode(term, c.qrCodeValue) || sameScanCode(term, c.barcodeValue),
    );

    // 2) Shipment-level TRACKING number match.
    let ambiguous: Array<{ externalCartonId: string; cartonNumber: number; totalCartons: number }> | null = null;
    if (!carton) {
      const shipment = arrival.shipments.find((s) => s.trackingNumber && sameScanCode(term, s.trackingNumber));
      if (shipment) {
        const cands = cards.filter((c) => c.shipmentId === shipment.id);
        const open = cands.filter((c) => c.status !== 'RECEIVED');
        if (open.length === 0) {
          carton = cands[0]; // all received -> completed-card reject below
        } else if (open.length === 1) {
          carton = open[0];
        } else {
          ambiguous = open.map((c) => ({ externalCartonId: c.externalCartonId, cartonNumber: c.cartonNumber, totalCartons: c.totalCartons }));
        }
      }
    }

    // AMBIGUOUS — a tracking number alone does not identify ONE carton.
    if (ambiguous) {
      await this.prisma.$transaction(async (tx) => {
        const log = await this.logWorker(tx, session, actor, {
          cardType: 'CARTON', operation: 'CONFIRM', identifierType, source,
          identifierValue: term, result: 'AMBIGUOUS', startedAt,
        });
        await this.audit.log({
          actorUserId: actor.id, action: 'CARTON_SCANNED' as never, entityType: 'receiving_worker_log',
          entityId: log.id, ipAddress: actor.ip ?? null,
          metadata: { session: session.code, tracking: term, candidates: ambiguous.map((a) => a.externalCartonId), identifierType, source },
        }, tx);
      });
      return this.sessionDetail(sessionId, {
        flash: {
          kind: 'TRACKING_AMBIGUOUS', cardType: 'CARTON', code: term,
          cartons: ambiguous,
          message: `The tracking number matches ${ambiguous.length} cartons. Scan the specific carton.`,
        },
      });
    }

    // MISMATCH — no carton card of this arrival matches.
    if (!carton) {
      // Distinguish "belongs to another arrival" for an actionable message.
      const other = await this.prisma.warehouseCarton.findFirst({
        where: {
          OR: [
            { externalCartonId: { equals: term, mode: 'insensitive' } },
            { cartonReference: { equals: term, mode: 'insensitive' } },
            { qrCodeValue: { equals: term, mode: 'insensitive' } },
            { barcodeValue: { equals: term, mode: 'insensitive' } },
          ],
        },
        include: { shipment: true },
      });
      const wrongShipment = !!other && other.shipment.arrivalId !== session.arrivalId;
      await this.prisma.$transaction(async (tx) => {
        const log = await this.logWorker(tx, session, actor, {
          cardType: 'CARTON', operation: 'CONFIRM', identifierType, source,
          identifierValue: term, result: 'MISMATCH', startedAt,
        });
        await this.audit.log({
          actorUserId: actor.id,
          action: (wrongShipment ? 'WRONG_SHIPMENT' : 'UNKNOWN_CARTON') as never,
          entityType: 'receiving_worker_log', entityId: log.id, ipAddress: actor.ip ?? null,
          metadata: { session: session.code, identifier: term, identifierType, source, shipment: other?.shipment.code ?? null },
        }, tx);
      });
      return this.sessionDetail(sessionId, {
        flash: {
          kind: wrongShipment ? 'WRONG_SHIPMENT' : 'MISMATCH', cardType: 'CARTON', code: term,
          shipment: other ? { code: other.shipment.code, externalShipmentId: other.shipment.externalShipmentId } : null,
          message: wrongShipment
            ? `${OPERATIONAL_ERRORS.cartonWrongShipment} (${other?.shipment.code})`
            : OPERATIONAL_ERRORS.cartonUnknown,
        },
      });
    }

    // Completed card -> REJECT (duplicate completion protection).
    if (carton.status === 'RECEIVED') {
      const ref = carton.externalCartonId;
      await this.prisma.$transaction(async (tx) => {
        const log = await this.logWorker(tx, session, actor, {
          cardType: 'CARTON', cardRef: ref, operation: 'DUPLICATE_REJECT', identifierType, source,
          identifierValue: term, result: 'DUPLICATE', startedAt,
        });
        await this.audit.log({
          actorUserId: actor.id, action: 'CARD_ALREADY_COMPLETED' as never, entityType: 'warehouse_carton',
          entityId: carton.id, ipAddress: actor.ip ?? null,
          metadata: { card: ref, identifier: term, identifierType, source, logId: log.id },
        }, tx);
      });
      return this.sessionDetail(sessionId, {
        flash: { kind: 'CARD_ALREADY_COMPLETE', cardType: 'CARTON', code: ref, message: OPERATIONAL_ERRORS.cartonDuplicate },
      });
    }

    // MATCH — persist the carton receipt.
    const ref = carton.externalCartonId;
    await this.prisma.$transaction(async (tx) => {
      const rc = await tx.receivingCarton.create({ data: {
        receivingSessionId: sessionId, cartonId: carton.id, scannedCode: ref,
        scanType: identifierType as never, source: scanSourceOf(source), status: 'RECEIVED',
        receivedBy: actor.id, receivedAt: new Date(), operationId: input.operationId ?? null,
      } });
      await tx.warehouseCarton.update({ where: { id: carton.id }, data: { status: 'RECEIVED', receivedAt: new Date(), receivedBy: actor.id } });
      const log = await this.logWorker(tx, session, actor, {
        cardType: 'CARTON', cardRef: ref, operation: 'CONFIRM', identifierType, source,
        identifierValue: term, result: 'MATCH', startedAt,
      });
      await this.audit.log({
        actorUserId: actor.id, action: 'CARTON_RECEIVED' as never, entityType: 'warehouse_carton',
        entityId: carton.id, ipAddress: actor.ip ?? null,
        metadata: { card: ref, number: carton.cartonNumber, of: carton.totalCartons, identifier: term, identifierType, source, receivingCartonId: rc.id, logId: log.id },
      }, tx);
    });
    return this.sessionDetail(sessionId, {
      flash: {
        kind: 'MATCH', cardType: 'CARTON', code: ref,
        carton: {
          id: carton.id, externalCartonId: carton.externalCartonId, reference: carton.cartonReference,
          cartonNumber: carton.cartonNumber, totalCartons: carton.totalCartons,
          trackingNumber: (carton as any).shipment?.trackingNumber ?? null,
        },
      },
    });
  }

  // ---------- mismatch reported by the device (local matching failure) ----------
  /**
   * The device matched the scanned identifier against its expected cards and
   * found NO match. Nothing is confirmed and nothing completes; the failure
   * is logged (worker activity + audit) so the Admin can see it.
   */
  async reportMismatch(sessionId: string, input: MismatchInput, actor: ReceivingActor) {
    const session = await this.requireActiveSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    const term = normalizeScan(input.identifier);
    if (!term) throw new BadRequestException(OPERATIONAL_ERRORS.cartonUnknown);
    const cardType: CardType = input.cardType === 'CARTON' ? 'CARTON' : 'PRODUCT';
    const identifierType = (input.identifierType ?? 'MANUAL') as IdentifierType;
    const source = input.source ?? 'MANUAL';
    const startedAt = parseDate(input.startedAt);

    await this.prisma.$transaction(async (tx) => {
      const log = await this.logWorker(tx, session, actor, {
        cardType, operation: 'SCAN_REJECT', identifierType, source,
        identifierValue: term, result: 'MISMATCH', startedAt,
      });
      await this.audit.log({
        actorUserId: actor.id,
        action: (cardType === 'PRODUCT' ? 'UNEXPECTED_PRODUCT' : 'UNKNOWN_CARTON') as never,
        entityType: 'receiving_worker_log', entityId: log.id, ipAddress: actor.ip ?? null,
        metadata: { session: session.code, identifier: term, identifierType, source, cardType },
      }, tx);
    });
    return this.sessionDetail(sessionId, {
      flash: {
        kind: 'MISMATCH', cardType, code: term,
        message: cardType === 'PRODUCT' ? OPERATIONAL_ERRORS.productNotMatched : OPERATIONAL_ERRORS.cartonUnknown,
      },
    });
  }

  // ---------- pause / resume ----------
  async pause(sessionId: string, actor: ReceivingActor) {
    const session = await this.requireSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    if (session.status !== 'RECEIVING') throw new ConflictException('Session is not active.');
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingSession.update({ where: { id: sessionId }, data: { status: 'PAUSED', pausedAt: new Date() } });
      await tx.expectedArrival.update({ where: { id: session.arrivalId }, data: { status: 'PAUSED' } });
      await this.audit.log({ actorUserId: actor.id, action: 'RECEIVING_PAUSED' as never, entityType: 'receiving_session', entityId: sessionId }, tx);
    });
    return this.sessionDetail(sessionId);
  }

  async resume(sessionId: string, actor: ReceivingActor) {
    const session = await this.requireSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    if (session.status !== 'PAUSED') throw new ConflictException('Session is not paused.');
    await this.prisma.$transaction(async (tx) => {
      await tx.receivingSession.update({ where: { id: sessionId }, data: { status: 'RECEIVING', resumedAt: new Date() } });
      await tx.expectedArrival.update({ where: { id: session.arrivalId }, data: { status: 'RECEIVING' } });
      await this.audit.log({ actorUserId: actor.id, action: 'RECEIVING_RESUMED' as never, entityType: 'receiving_session', entityId: sessionId }, tx);
    });
    return this.sessionDetail(sessionId);
  }

  // ---------- flag / resolve discrepancy ----------
  async flag(sessionId: string, payload: { code?: string; sku?: string; reason?: string }, actor: ReceivingActor) {
    const current = await this.requireActiveSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: current.arrivalId });
    const type = payload.sku ? 'IDENTIFICATION_ERROR' : 'UNKNOWN_CARTON';
    await this.prisma.receivingDiscrepancy.create({ data: {
      receivingSessionId: sessionId, type: type as any, reason: payload.reason || payload.code || payload.sku || 'Flagged',
      status: 'OPEN', createdBy: actor.id,
    } });
    return this.sessionDetail(sessionId);
  }

  async resolveDiscrepancy(discrepancyId: string, resolution: string, actor: ReceivingActor) {
    if (!actor.canResolveDiscrepancy) {
      throw new ForbiddenException('Only a supervisor can resolve discrepancies.');
    }
    await this.prisma.$transaction(async (tx) => {
      const d = await tx.receivingDiscrepancy.update({
        where: { id: discrepancyId },
        data: { status: 'RESOLVED', resolvedBy: actor.id, resolvedAt: new Date(), resolution: resolution || 'Resolved' },
      });
      // If an OVERAGE was approved, keep the line OVERAGE but discrepancy closed.
      await this.audit.log({ actorUserId: actor.id, action: 'DISCREPANCY_RESOLVED' as never, entityType: 'receiving_discrepancy',
        entityId: d.id, metadata: { type: d.type, resolution } }, tx);
    });
    const d = await this.prisma.receivingDiscrepancy.findUnique({ where: { id: discrepancyId } });
    return this.sessionDetail(d!.receivingSessionId);
  }

  // ---------- complete ----------
  async complete(sessionId: string, actor: ReceivingActor) {
    const session = await this.requireActiveSession(sessionId);
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    const tally = await this.reconcile(sessionId);

    const hasOpenDiscrepancies = tally.openDiscrepancies > 0
      || tally.shortUnits > 0 || tally.overageUnits > 0 || tally.unexpectedProducts > 0 || tally.missingCartons > 0;

    if (hasOpenDiscrepancies && !actor.canResolveDiscrepancy) {
      throw new ForbiddenException('Receiving has discrepancies; a supervisor must close it.');
    }

    const finalStatus = hasOpenDiscrepancies ? 'COMPLETED_WITH_DISCREPANCY' : 'COMPLETED';
    const arrivalStatus = hasOpenDiscrepancies ? 'RECEIVED_WITH_DISCREPANCY' : 'RECEIVED';

    await this.prisma.$transaction(async (tx) => {
      await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId }, tx);
      const changed = await tx.receivingSession.updateMany({
        where: { id: sessionId, status: 'RECEIVING' },
        data: { status: finalStatus as any, completedBy: actor.id, completedAt: new Date() },
      });
      if (changed.count !== 1) throw new ConflictException('Receiving already changed or completed.');
      await tx.expectedArrival.update({ where: { id: session.arrivalId }, data: { status: arrivalStatus as any } });
      // Mark short lines.
      if (hasOpenDiscrepancies) {
        await tx.receivingProduct.updateMany({
          where: { receivingSessionId: sessionId, status: { in: ['EXPECTED', 'PARTIALLY_RECEIVED'] } },
          data: { status: 'SHORT' },
        });
      }
      await this.audit.log({
        actorUserId: actor.id,
        action: (hasOpenDiscrepancies ? 'RECEIVING_COMPLETED_WITH_DISCREPANCY' : 'RECEIVING_COMPLETED') as never,
        entityType: 'receiving_session', entityId: sessionId, ipAddress: actor.ip ?? null,
        metadata: { finalStatus: arrivalStatus, tally, workerId: actor.id, stationId: session.stationId, previousState: session.status },
      }, tx);
      await this.assignments.receivingCompleted(session.arrivalId, hasOpenDiscrepancies, session.code, actor.id, tx);
    }).then(() => {
      // Master Order §9: RECEIVING COMPLETED → the container/placement task
      // for each tote of the session is auto-created for the next worker.
      return this.dispatch.onReceivingCompleted(
        { id: session.id, code: session.code, arrivalId: session.arrivalId },
        actor.id,
        { reason: `receiving ${session.code} completed` },
      );
    });
    return this.sessionDetail(sessionId);
  }

  // ---------- read ----------
  async listForReceiving() {
    // Arrivals that are expected/receiving and have at least a shipment or just expected.
    const arrivals = await this.prisma.expectedArrival.findMany({
      where: { status: { in: ['EXPECTED', 'RECEIVING', 'PAUSED'] } },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { items: true, shipments: true } }, shipments: { include: { cartons: true } } },
    });
    return arrivals.map((a) => ({
      id: a.id, code: a.code, customerName: a.customerName, storeName: a.storeName,
      status: a.status, products: a.productCount, units: a.totalUnits,
      shipments: a._count.shipments,
      carrier: a.shipments[0]?.carrierName ?? null,
      tracking: a.shipments[0]?.trackingNumber ?? null,
      cartons: a.shipments.reduce((n, s) => n + s.cartons.length, 0),
    }));
  }

  private async requireSession(id: string) {
    const s = await this.prisma.receivingSession.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Receiving session not found.');
    return s;
  }
  private async requireActiveSession(id: string) {
    const s = await this.requireSession(id);
    if (s.status === 'COMPLETED' || s.status === 'COMPLETED_WITH_DISCREPANCY' || s.status === 'CANCELLED') {
      throw new ConflictException('Receiving session is closed.');
    }
    return s;
  }

  /** A card confirmation only ever applies to a session that is actively RECEIVING (a paused session rejects it). */
  private async requireConfirmableSession(id: string) {
    const s = await this.requireActiveSession(id);
    if (s.status !== 'RECEIVING') throw new ConflictException('Session is not active.');
    return s;
  }

  async reconcile(sessionId: string) {
    const session = await this.requireSession(sessionId);
    const [products, openDisc, receivedCartons, arrivalWithShipments] = await Promise.all([
      this.prisma.receivingProduct.findMany({ where: { receivingSessionId: sessionId } }),
      this.prisma.receivingDiscrepancy.count({ where: { receivingSessionId: sessionId, status: 'OPEN' } }),
      this.prisma.receivingCarton.count({ where: { receivingSessionId: sessionId, status: 'RECEIVED' } }),
      this.prisma.expectedArrival.findUnique({
        where: { id: session.arrivalId },
        include: { shipments: { include: { cartons: true } } },
      }),
    ]);
    const expectedUnits = products.filter((p) => p.expectedQuantity > 0).reduce((n, p) => n + p.expectedQuantity, 0);
    const receivedUnits = products.reduce((n, p) => n + p.receivedQuantity, 0);
    const expectedProducts = products.filter((p) => p.expectedQuantity > 0).length;
    const receivedProducts = products.filter((p) => p.expectedQuantity > 0 && p.receivedQuantity >= p.expectedQuantity).length;
    const expectedCartons = arrivalWithShipments?.shipments.reduce((n, s) => n + s.cartons.length, 0) ?? 0;
    const shortUnits = products
      .filter((p) => p.expectedQuantity > 0 && p.receivedQuantity < p.expectedQuantity)
      .reduce((n, p) => n + (p.expectedQuantity - p.receivedQuantity), 0);
    const overageUnits = products.filter((p) => p.status === 'OVERAGE').reduce((n, p) => n + p.difference, 0);
    const unexpectedProducts = products.filter((p) => p.status === 'UNEXPECTED').length;
    return {
      expectedCartons, receivedCartons,
      expectedProducts, receivedProducts,
      expectedUnits, receivedUnits,
      openDiscrepancies: openDisc,
      shortUnits: Math.max(0, shortUnits),
      overageUnits: Math.max(0, overageUnits),
      unexpectedProducts,
      missingCartons: Math.max(0, expectedCartons - receivedCartons),
    };
  }

  /**
   * Session payload for the worker terminal. Carries the expected CARD data
   * (productCards / cartonCards) used for DEVICE-SIDE MATCHING on the worker
   * device, the live tally and the latest flash. Cards stay independent:
   * PRODUCT cards only in the PRODUIT lane, CARTON cards only in the CARTON
   * lane — they are never merged or mutated by receiving.
   */
  async sessionDetail(sessionId: string, opts?: { flash?: any }) {
    const session = await this.prisma.receivingSession.findUnique({
      where: { id: sessionId },
      include: {
        expectedArrival: { include: { shipments: { include: { cartons: { orderBy: { cartonNumber: 'asc' } } } } } },
        shipment: true,
        products: { orderBy: { status: 'asc' } },
        discrepancies: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!session) throw new NotFoundException('Receiving session not found.');

    const tally = await this.reconcile(sessionId);
    const primaryShipment = session.shipment
      ? (session.expectedArrival.shipments.find((s) => s.id === session.shipmentId) ?? session.shipment)
      : session.expectedArrival.shipments[0] ?? null;

    // PRODUCT CARDS (Customer Arrival Card lines, session-scoped).
    const productCards: ProductCard[] = session.products.map((p) => ({
      id: p.id,
      sku: p.sku,
      reference: p.reference,
      productName: p.productName,
      category: p.category ?? null,
      subcategory: p.subcategory ?? null,
      categoryStatus: p.categoryStatus ?? 'NEEDS_REVIEW',
      expected: p.expectedQuantity,
      received: p.receivedQuantity,
      remaining: Math.max(0, p.expectedQuantity - p.receivedQuantity),
      status: p.status,
      identifiers: cardIdentifiers([p.sku, p.reference]),
    }));

    // CARTON CARDS (Shipment Card cartons, ALL shipments of the arrival) with
    // the shipment-level card data (tracking / sender / shipped date).
    const cartonCards: CartonCard[] = [];
    for (const s of session.expectedArrival.shipments) {
      for (const c of s.cartons) {
        cartonCards.push({
          id: c.id,
          externalCartonId: c.externalCartonId,
          reference: c.cartonReference,
          qrCodeValue: c.qrCodeValue,
          barcodeValue: c.barcodeValue,
          cartonNumber: c.cartonNumber,
          totalCartons: c.totalCartons,
          trackingNumber: s.trackingNumber ?? null,
          senderName: s.senderName ?? null,
          shippedAt: s.shippedAt ? new Date(s.shippedAt).toISOString() : null,
          weight: c.weight,
          weightUnit: c.weightUnit,
          dimensions: c.length != null || c.width != null || c.height != null
            ? { length: c.length, width: c.width, height: c.height, unit: c.dimensionUnit ?? null }
            : null,
          status: c.status,
          identifiers: cardIdentifiers([c.externalCartonId, c.cartonReference, c.qrCodeValue, c.barcodeValue]),
        });
      }
    }

    return {
      id: session.id,
      code: session.code,
      status: session.status,
      startedAt: session.startedAt,
      pausedAt: session.pausedAt,
      completedAt: session.completedAt,
      deviceType: session.deviceType ?? null,
      deviceName: session.deviceName ?? null,
      scanSource: session.scanSource ?? null,
      arrival: {
        id: session.expectedArrival.id,
        code: session.expectedArrival.code,
        externalArrivalId: session.expectedArrival.arrivalId,
        customerName: session.expectedArrival.customerName,
        customerId: session.expectedArrival.customerId,
        storeName: session.expectedArrival.storeName,
        status: session.expectedArrival.status,
      },
      shipment: primaryShipment ? {
        id: primaryShipment.id, code: primaryShipment.code, externalShipmentId: primaryShipment.externalShipmentId,
        carrierName: primaryShipment.carrierName, carrierCode: primaryShipment.carrierCode,
        trackingNumber: primaryShipment.trackingNumber,
        senderName: primaryShipment.senderName, senderCompany: primaryShipment.senderCompany,
        shippedAt: primaryShipment.shippedAt ? new Date(primaryShipment.shippedAt).toISOString() : null,
        totalCartons: primaryShipment.totalCartons, totalProducts: primaryShipment.totalProducts, totalUnits: primaryShipment.totalUnits,
      } : null,
      productCards,
      cartonCards,
      discrepancies: session.discrepancies.map((d) => ({
        id: d.id, type: d.type, status: d.status, reason: d.reason,
        expected: d.expectedQuantity, actual: d.actualQuantity, difference: d.difference, resolution: d.resolution,
      })),
      tally,
      flash: opts?.flash ?? null,
    };
  }

  async activeSessionForArrival(arrivalIdOrCode: string) {
    const arrival = await this.prisma.expectedArrival.findFirst({
      where: { OR: [{ id: arrivalIdOrCode }, { code: arrivalIdOrCode }] },
    });
    if (!arrival) throw new NotFoundException('Expected arrival not found.');
    const s = await this.prisma.receivingSession.findFirst({
      where: { arrivalId: arrival.id, status: { in: ['RECEIVING', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
    });
    return s ? this.sessionDetail(s.id) : null;
  }
}
