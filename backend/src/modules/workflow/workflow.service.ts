import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { normalizeScan } from '../../common/scan-normalizer';

/**
 * WORKFLOW SEPARATION — Carton flow vs Product flow.
 *
 *   CARTON FLOW : Receiving -> Verification -> Rapport Verification -> Admin -> END
 *   PRODUCT FLOW: Receiving -> Temporary Storage -> Sorting -> Packing -> Ready to Shipping
 *
 * This service owns two things:
 *  1. The append-only WorkflowEvent ledger (IDs + history + status per item,
 *     never mixing cartons and products after Receiving).
 *  2. The product-station guard: a carton identifier presented at Temporary
 *     Storage / Sorting / Packing / Shipping is REJECTED with an actionable
 *     message, because the carton flow already ended at the report.
 */

export type WorkflowFlow = 'CARTON' | 'PRODUCT';

export type WorkflowEventName =
  | 'RECEIVING_VERIFIED'
  | 'CARTON_FLOW_ENDED'
  | 'PRODUCT_HANDOFF_TEMP'
  | 'TEMP_STORAGE_RECEIVED'
  | 'TEMP_STORAGE_STAGED'
  | 'TEMP_STORAGE_READY'
  | 'TEMP_STORAGE_MOVED_TO_SORTING'
  | 'GUARD_REJECTED_CARTON';

export interface WorkflowEventInput {
  flow: WorkflowFlow;
  event: WorkflowEventName;
  entityType: 'carton' | 'product' | 'report' | 'temp_intake';
  entityId?: string | null;
  entityCode?: string | null;
  receivingSessionId?: string | null;
  fromStation?: string | null;
  toStation?: string | null;
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
}

type Db = Prisma.TransactionClient | PrismaService;

export const CARTON_FLOW_ENDED_MESSAGE =
  'Carton flow ended at Receiving. Cartons are reported in the verification report for Admin — they never enter Temporary Storage, Sorting, Packing or Shipping.';

@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Append one row to the workflow ledger (inside the caller's tx when given). */
  async logEvent(input: WorkflowEventInput, db: Db = this.prisma) {
    return (db as Prisma.TransactionClient).workflowEvent.create({
      data: {
        flow: input.flow,
        event: input.event,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityCode: input.entityCode ?? null,
        receivingSessionId: input.receivingSessionId ?? null,
        fromStation: input.fromStation ?? null,
        toStation: input.toStation ?? null,
        actorId: input.actorId ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** Full ordered history of one item (traceability without mixing flows). */
  async historyFor(entityType: string, entityId: string) {
    return this.prisma.workflowEvent.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Recent ledger rows for one receiving session (both flows, labelled). */
  async historyForSession(receivingSessionId: string) {
    return this.prisma.workflowEvent.findMany({
      where: { receivingSessionId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  /**
   * PRODUCT-STATION GUARD.
   *
   * Returns the matched carton (for the audit row) when `rawCode` is a known
   * carton identifier — carton id / reference / QR / barcode / suivi /
   * tracking code, shipment tracking, or a previously received scan — else null.
   * Product/operational codes (SKU, ART-, RCN-, BIN-, OUT-, TMP-, locations)
   * never match: the lookup only touches carton tables.
   */
  async findCartonByIdentifier(rawCode: string) {
    const code = normalizeScan(rawCode);
    if (!code) return null;
    const eq = { equals: code, mode: 'insensitive' } as const;
    const carton = await this.prisma.warehouseCarton.findFirst({
      where: {
        OR: [
          { externalCartonId: eq },
          { cartonReference: eq },
          { qrCodeValue: eq },
          { barcodeValue: eq },
          { suiviCode: eq },
          { trackingCode: eq },
        ],
      },
      select: { id: true, externalCartonId: true, status: true },
    });
    if (carton) return carton;
    const tracked = await this.prisma.warehouseShipment.findFirst({
      where: { OR: [{ trackingNumber: eq }, { suiviCode: eq }] },
      select: { id: true, code: true },
    });
    if (tracked) {
      return { id: tracked.id, externalCartonId: tracked.code, status: 'TRACKED_SHIPMENT' };
    }
    const scanned = await this.prisma.receivingCarton.findFirst({
      where: { scannedCode: eq },
      select: { id: true, scannedCode: true },
    });
    if (scanned) {
      return { id: scanned.id, externalCartonId: scanned.scannedCode, status: 'SCANNED' };
    }
    return null;
  }

  /**
   * Reject a carton identifier at a product-only station with HTTP 409 +
   * audited guard row. Called from every Temporary Storage / Sorting /
   * Packing / Shipping scan entry point (on lookup miss, so legitimate
   * product codes can never false-positive). Non-carton codes pass through.
   * Actor is optional: read-only scans audit with a null actor.
   */
  async assertNotCartonIdentifier(
    rawCode: string,
    station: string,
    actor?: { id?: string | null; ip?: string | null },
    db: Db = this.prisma,
  ) {
    const hit = await this.findCartonByIdentifier(rawCode);
    if (!hit) return;
    const code = normalizeScan(rawCode);
    await this.audit.log(
      {
        actorUserId: actor?.id ?? null,
        action: 'WORKFLOW_GUARD_REJECTED',
        entityType: 'carton',
        entityId: hit.id,
        ipAddress: actor?.ip ?? null,
        metadata: { station, scanned: code, carton: hit.externalCartonId },
      },
      db as Prisma.TransactionClient,
    );
    await this.logEvent(
      {
        flow: 'CARTON',
        event: 'GUARD_REJECTED_CARTON',
        entityType: 'carton',
        entityId: hit.id,
        entityCode: hit.externalCartonId,
        toStation: station,
        actorId: actor?.id ?? null,
        metadata: { scanned: code },
      },
      db,
    );
    throw new ConflictException(CARTON_FLOW_ENDED_MESSAGE);
  }
}
