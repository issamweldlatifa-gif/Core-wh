import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface WorkflowActor {
  id: string;
  ip?: string | null;
}

/**
 * Official station chain (workflow order).
 *
 * TWO SEPARATE FLOWS (never mixed):
 *   - Carton Flow: Receiving -> Verification -> Rapport -> Admin -> END.
 *     Cartons NEVER enter this chain past Receiving.
 *   - Product Flow (Produit + Carte): Receiving -> Temporary Storage ->
 *     Sorting -> Packing -> Ready to Shipping. THIS chain below.
 *
 * Temporary Storage IS the STAGING department (seeded station ST-STG-01
 * "Temporary Storage 1" + STG zone) — mapped, not rebuilt. Ready to
 * Shipping is the final step at DISPATCH. Phases 3-5 plug their own
 * handoff + inbox onto the same move ledger; only their contracts are
 * declared here until their phase ships.
 */
export const STATION_CHAIN = [
  {
    order: 1,
    department: 'RECEIVING',
    label: 'Receiving',
    inputFrom: null as string | null,
    inputContract:
      'ExpectedArrival + shipments/cartons pushed by the Arrival CRM. Entry point; verification locks here.',
    live: true,
  },
  {
    order: 2,
    department: 'STAGING',
    label: 'Temporary Storage',
    inputFrom: 'RECEIVING',
    inputContract:
      'Product Flow only (Produit + Carte): locked CONFIRMED verification lines with confirmed quantities, product identity, session/arrival references and handoff trace. Delivered automatically at report submit; intake is accepted per station. NO cartons. Backend destination only — no station UI in this phase.',
    live: true,
  },
  {
    order: 3,
    department: 'SORTING',
    label: 'Sorting',
    inputFrom: 'STAGING',
    inputContract:
      'Accepted Temporary Storage product moves. Products only, never cartons. PLANNED — phase 3 builds this handoff.',
    live: false,
  },
  {
    order: 4,
    department: 'PACKING',
    label: 'Packing',
    inputFrom: 'SORTING',
    inputContract: 'Sorted products. PLANNED — phase 4 builds this handoff.',
    live: false,
  },
  {
    order: 5,
    department: 'DISPATCH',
    label: 'Ready to Shipping',
    inputFrom: 'PACKING',
    inputContract:
      'Packed consignments ready to ship (final state before shipping). PLANNED — phase 5 builds this handoff.',
    live: false,
  },
];

/**
 * Station-chain workflow (Phase 2: Receiving -> Temporary Storage, Product Flow).
 *
 * No duplicated product records: a product's position is its latest
 * ProductStationMove, and the move ledger is append-only (intake CLOSES the
 * pending move via acceptedAt — same pattern as CartonPlacement.releasedAt).
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  chain() {
    return { chain: STATION_CHAIN };
  }

  /**
   * Receiving Output B -> Temporary Storage Input (Product Flow).
   *
   * Called INSIDE the report-submit transaction, right after the verification
   * snapshot locks: every locked CONFIRMED line with confirmedQuantity > 0
   * hands its quantity to the STAGING pool. DAMAGED / MISSING / PENDING lines
   * move nothing (nothing verified to hand over). Atomic with the lock;
   * idempotent per report line (reason `receiving-submit:<sessionId>`).
   */
  async handoffReceivingToStaging(
    tx: Prisma.TransactionClient,
    sessionId: string,
    actor: WorkflowActor,
  ) {
    const session = await tx.receivingSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Receiving session not found.');
    const report = await tx.receivingReport.findUnique({
      where: { receivingSessionId: sessionId },
      include: {
        lines: {
          where: { result: 'CONFIRMED', confirmedQuantity: { gt: 0 } },
          include: { receivingProduct: true },
        },
      },
    });
    if (!report) throw new NotFoundException('Locked verification report not found.');
    const reason = `receiving-submit:${sessionId}`;
    let moved = 0;
    for (const line of report.lines) {
      const existing = await tx.productStationMove.findFirst({
        where: { reportLineId: line.id, toDepartment: 'STAGING', reason },
      });
      if (existing) continue;
      await tx.productStationMove.create({
        data: {
          sku: line.sku,
          reference: line.reference,
          productName: line.productName,
          arrivalItemId: line.receivingProduct?.arrivalItemId ?? null,
          receivingProductId: line.receivingProductId,
          reportLineId: line.id,
          receivingSessionId: sessionId,
          expectedQuantity: line.expectedQuantity,
          confirmedQuantity: line.confirmedQuantity,
          result: 'CONFIRMED',
          fromStationId: session.stationId ?? null,
          toDepartment: 'STAGING',
          actorId: actor.id,
          reason,
        },
      });
      moved += 1;
    }
    await this.audit.log(
      {
        actorUserId: actor.id,
        action: 'TEMPORARY_STORAGE_HANDOFF' as never,
        entityType: 'receiving_session',
        entityId: sessionId,
        ipAddress: actor.ip ?? null,
        metadata: { session: session.code, movedLines: moved },
      },
      tx,
    );
    return { moved };
  }

  /**
   * Temporary Storage inbox: product moves whose LATEST position is STAGING,
   * each with the Receiving Output attached (product identity, quantities,
   * verdict, session/arrival references, handoff trace). This is the
   * official Input contract of the next station. Never contains cartons.
   */
  async stagingInbox() {
    const moves = await this.prisma.productStationMove.findMany({
      where: { toDepartment: 'STAGING' },
      include: {
        fromStation: true,
        toStation: true,
        receivingProduct: { include: { session: { include: { expectedArrival: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Keep only lines whose latest move is this STAGING one (a later phase
    // moves a line onward by appending a new move — history is never edited).
    const lineIds = [...new Set(moves.map((m) => m.reportLineId).filter((v): v is string => !!v))];
    const latestIdByLine = new Map<string, string>();
    if (lineIds.length > 0) {
      const latests = await this.prisma.productStationMove.findMany({
        where: { reportLineId: { in: lineIds } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, reportLineId: true },
      });
      for (const m of latests) {
        if (m.reportLineId && !latestIdByLine.has(m.reportLineId)) latestIdByLine.set(m.reportLineId, m.id);
      }
    }
    const inbox = moves.filter(
      (m) => !m.reportLineId || latestIdByLine.get(m.reportLineId) === m.id,
    );
    return {
      station: 'STAGING',
      label: 'Temporary Storage',
      flow: 'PRODUCT',
      count: inbox.length,
      items: inbox.map((m) => ({
        moveId: m.id,
        product: { sku: m.sku, reference: m.reference, productName: m.productName },
        quantities: { expected: m.expectedQuantity, confirmed: m.confirmedQuantity },
        result: m.result,
        session: m.receivingProduct?.session
          ? { id: m.receivingProduct.session.id, code: m.receivingProduct.session.code }
          : null,
        arrival: m.receivingProduct?.session?.expectedArrival
          ? {
              id: m.receivingProduct.session.expectedArrival.id,
              code: (m.receivingProduct.session.expectedArrival as any).code ?? null,
            }
          : null,
        reportLineId: m.reportLineId,
        handoff: {
          at: m.createdAt,
          by: m.actorId,
          reason: m.reason,
          fromStation: m.fromStation
            ? { id: m.fromStation.id, code: m.fromStation.code, name: m.fromStation.name }
            : null,
          accepted: m.acceptedAt != null,
          acceptedAt: m.acceptedAt,
          station: m.toStation
            ? { id: m.toStation.id, code: m.toStation.code, name: m.toStation.name }
            : null,
        },
      })),
    };
  }

  /**
   * Temporary Storage intake: a STAGING station accepts a waiting product
   * move. Closes the pending move (acceptedAt). The logical department stays
   * STAGING; the NEXT phase moves it to SORTING by appending a new move.
   */
  async acceptAtStaging(moveId: string, stationId: string, actor: WorkflowActor) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } });
    if (!station || station.department !== 'STAGING') {
      throw new BadRequestException('Station is not a Temporary Storage station.');
    }
    if (station.status !== 'ACTIVE') {
      throw new ConflictException('Station is not active.');
    }
    const move = await this.prisma.productStationMove.findUnique({ where: { id: moveId } });
    if (!move) throw new NotFoundException('Product move not found.');
    if (move.toDepartment !== 'STAGING') {
      throw new ConflictException(`Move targets ${move.toDepartment}, not Temporary Storage.`);
    }
    if (move.acceptedAt) {
      throw new ConflictException('This move was already accepted.');
    }
    if (move.reportLineId) {
      const newer = await this.prisma.productStationMove.findFirst({
        where: { reportLineId: move.reportLineId, createdAt: { gt: move.createdAt } },
        select: { id: true },
      });
      if (newer) throw new ConflictException('This move was superseded by a newer one.');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.productStationMove.update({
        where: { id: moveId },
        data: { toStationId: stationId, acceptedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'TEMPORARY_STORAGE_ACCEPTED' as never,
          entityType: 'product_station_move',
          entityId: moveId,
          ipAddress: actor.ip ?? null,
          metadata: { station: station.code, sku: move.sku, confirmed: move.confirmedQuantity },
        },
        tx,
      );
      return {
        moveId,
        station: { id: station.id, code: station.code, name: station.name },
        acceptedAt: new Date().toISOString(),
      };
    });
  }
}
