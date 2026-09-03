import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TASK_REGISTRY } from './terminal.service';

/**
 * Admin Control Center read models (spec §36/§37/§38).
 *
 * These are deliberately read-only projections. Every mutation an admin can
 * perform goes through CorrectionsService so it is reasoned about, permission
 * checked and audited in one place (§7).
 *
 * V1 control room (§4–§9): `overview()` returns ONE aggregated payload
 * (warehouse + system + counters + pipeline + operations + workers +
 * stations + exceptions + live activity) so the Control Center does not
 * hammer the backend with tens of requests — one round trip, then a bounded
 * poll. Every number below is computed from real rows; a metric that has no
 * data source stays absent and the UI renders it as NOT AVAILABLE, never as
 * a fabricated figure.
 */

/** Severity is a *policy* classification of an exception TYPE (documented,
 * constant) — not invented operational data. It lets the exception center
 * triage CRITICAL/HIGH/MEDIUM/LOW consistently. */
const EXCEPTION_SEVERITY: Record<string, 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'> = {
  WRONG_SHIPMENT: 'CRITICAL', // stock physically routed to the wrong flow
  UNKNOWN_CARTON: 'HIGH', // a physical carton we cannot identify
  MISSING_CARTON: 'HIGH', // announced carton never found
  MISSING_PRODUCT: 'HIGH', // announced product never found
  UNEXPECTED_PRODUCT: 'HIGH', // SKU not on the expected line
  SHORTAGE: 'MEDIUM',
  OVERAGE: 'MEDIUM',
  IDENTIFICATION_ERROR: 'MEDIUM',
  DUPLICATE_SCAN: 'MEDIUM',
  OTHER: 'LOW',
};

export function exceptionSeverity(type: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  return EXCEPTION_SEVERITY[type] ?? 'MEDIUM';
}

/** Operational audit actions that power the Live Activity feed. System/identity
 * events (users, roles, settings) are deliberately excluded — the Control
 * Center is gated on operations.view, not audit.view. */
const OPS_AUDIT_ACTIONS = [
  'RECEIVING_STARTED',
  'RECEIVING_PAUSED',
  'RECEIVING_RESUMED',
  'RECEIVING_COMPLETED',
  'RECEIVING_COMPLETED_WITH_DISCREPANCY',
  'CARTON_SCANNED',
  'CARTON_RECEIVED',
  'CARTON_MANUAL_ENTRY',
  'UNKNOWN_CARTON',
  'WRONG_SHIPMENT',
  'DUPLICATE_CARTON',
  'PRODUCT_SCANNED',
  'PRODUCT_RECEIVED',
  'UNEXPECTED_PRODUCT',
  'DISCREPANCY_CREATED',
  'DISCREPANCY_RESOLVED',
  'ARTICLE_SCANNED',
  'PUTAWAY_STARTED',
  'PUTAWAY_PAUSED',
  'PUTAWAY_RESUMED',
  'PUTAWAY_COMPLETED',
  'ITEM_STORED',
  'ITEM_MOVED',
  'ITEM_PICKED',
  'SORTING_DESTINATION_SELECTED',
  'CONTAINER_CREATED',
  'CONTAINER_READY_FOR_PACKING',
  'CONTAINER_CLOSED',
  'ORDER_PACKED',
  'SHIPMENT_DISPATCHED',
  'CORRECTION_APPLIED',
  'RECEIVING_REVERSED',
  'SESSION_REOPENED',
  'CATEGORY_VALIDATED',
  'CATEGORY_NEEDS_REVIEW',
  'CATEGORY_MANUALLY_CHANGED',
] as AuditAction[];

/** Human/barcode code to show in the activity stream for an audit row, in
 * priority order of metadata keys. */
const ENTITY_CODE_KEYS = ['article', 'shipment', 'bin', 'container', 'carton', 'session', 'location', 'order'];

type Metric = { key: string; value: number; unit: string };

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Latest operational-audit timestamp per user (one typed aggregate query).
   * Plain `groupBy._max` on the audit log is avoided so the Control Center
   * does not force TS/prisma type gymnastics in a hot read path. */
  private async lastOpsActivityByUser(userIds: string[]): Promise<Map<string, Date>> {
    const map = new Map<string, Date>();
    if (userIds.length === 0) return map;
    const rows = await this.prisma.$queryRaw<Array<{ actorUserId: string; maxAt: Date | string }>>(
      Prisma.sql`
        SELECT "actorUserId" AS "actorUserId", MAX("createdAt") AS "maxAt"
        FROM "audit_logs"
        WHERE "actorUserId" IN (${Prisma.join(userIds)})
          AND "action"::text IN (${Prisma.join([...OPS_AUDIT_ACTIONS] as string[])})
        GROUP BY "actorUserId"`,
    );
    for (const row of rows) map.set(row.actorUserId, new Date(String(row.maxAt)));
    return map;
  }

  /** Live floor overview: one payload for the Control Center (§4–§9). */
  async overview() {
    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const [
      stations,
      activeSessions,
      todaySessions,
      openDiscrepancies,
      expectedArrivals,
      cartonsToday,
      pendingCorrections,
      activePutaway,
      cartonsStoredToday,
      awaitingPutaway,
      openOrders,
      articlesAwaitingSorting,
      articlesStored,
      binsReadyForPacking,
      shipmentsReadyToShip,
      shippedToday,
      // --- Control Center V1 additions -------------------------------
      warehouse,
      arrivalsNotStarted,
      arrivalsInProgress,
      arrivalsReceived,
      sessionsCompletedToday,
      toteContainersActive,
      piecesStoredToday,
      articlesAwaitingOrder,
      articlesInCustomerBins,
      customerBinsActive,
      customerBinsDoneToday,
      outboundPackedToday,
      shippedTotal,
      closedBinsTotal,
    ] = await Promise.all([
      this.prisma.station.findMany({
        orderBy: [{ department: 'asc' }, { code: 'asc' }],
        include: { assignedWorker: { select: { id: true, name: true, employeeCode: true } } },
      }),
      this.prisma.receivingSession.findMany({
        where: { status: { in: ['RECEIVING', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        include: {
          expectedArrival: { select: { id: true, code: true, customerName: true, storeName: true } },
          station: { select: { code: true } },
          _count: { select: { cartons: true, discrepancies: true } },
        },
      }),
      this.prisma.receivingSession.count({ where: { startedAt: { gte: since } } }),
      this.prisma.receivingDiscrepancy.count({ where: { status: 'OPEN' } }),
      this.prisma.expectedArrival.count({ where: { status: { in: ['EXPECTED', 'RECEIVING', 'PAUSED'] } } }),
      this.prisma.receivingCarton.count({ where: { createdAt: { gte: since }, status: 'RECEIVED' } }),
      this.prisma.operationCorrection.count({ where: { createdAt: { gte: since } } }),
      this.prisma.putawaySession.findMany({
        where: { status: { in: ['ACTIVE', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        include: {
          worker: { select: { id: true, name: true, employeeCode: true } },
          station: { select: { code: true } },
          _count: { select: { placements: true } },
        },
      }),
      this.prisma.cartonPlacement.count({ where: { placedAt: { gte: since } } }),
      this.prisma.warehouseCarton.count({
        where: { status: 'RECEIVED', currentLocationId: null },
      }),
      // Fulfillment pipeline (operational flow §1–§7).
      this.prisma.warehouseOrder.count({ where: { status: 'OPEN' } }),
      this.prisma.articleUnit.count({ where: { status: 'IN_CONTAINER' } }),
      this.prisma.articleUnit.count({ where: { status: 'STORED' } }),
      this.prisma.operationalContainer.count({
        where: { type: 'CUSTOMER', status: 'READY_FOR_PACKING' },
      }),
      this.prisma.outboundShipment.count({ where: { status: 'READY_TO_SHIP' } }),
      this.prisma.outboundShipment.count({
        where: { status: 'SHIPPED', shippedAt: { gte: since } },
      }),
      // Control Center V1 — pipeline / panels / status line.
      this.prisma.warehouse.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, code: true, name: true, status: true },
      }),
      this.prisma.expectedArrival.count({ where: { status: 'EXPECTED' } }),
      this.prisma.expectedArrival.count({ where: { status: { in: ['RECEIVING', 'PAUSED'] } } }),
      this.prisma.expectedArrival.count({
        where: { status: { in: ['RECEIVED', 'RECEIVED_WITH_DISCREPANCY'] } },
      }),
      this.prisma.receivingSession.count({
        where: {
          status: { in: ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'] },
          completedAt: { gte: since },
        },
      }),
      this.prisma.operationalContainer.count({ where: { type: 'RECEIVING', status: 'ACTIVE' } }),
      this.prisma.articleUnit.count({ where: { status: 'STORED', storedAt: { gte: since } } }),
      this.prisma.articleUnit.count({
        where: {
          orderId: null,
          status: { in: ['RECEIVED', 'IN_CONTAINER', 'STORED'] },
        },
      }),
      this.prisma.articleUnit.count({ where: { status: 'IN_CUSTOMER_BIN' } }),
      this.prisma.operationalContainer.count({ where: { type: 'CUSTOMER', status: 'ACTIVE' } }),
      this.prisma.operationalContainer.count({
        where: { type: 'CUSTOMER', status: { in: ['PACKED', 'CLOSED'] }, updatedAt: { gte: since } },
      }),
      this.prisma.outboundShipment.count({ where: { packedAt: { gte: since } } }),
      this.prisma.outboundShipment.count({ where: { status: 'SHIPPED' } }),
      this.prisma.operationalContainer.count({ where: { type: 'CUSTOMER', status: 'CLOSED' } }),
    ]);

    // ---- resolve identity + presence in few extra queries -------------
    const putawayByWorker = new Map(
      activePutaway.filter((p) => p.workerId).map((p) => [p.workerId as string, p]),
    );
    const sessionByWorker = new Map(
      activeSessions.filter((s) => s.startedBy).map((s) => [s.startedBy as string, s]),
    );

    const activeUsers = await this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
        stationsAssigned: { select: { id: true, code: true, name: true, department: true } },
      },
    });
    const userIds = activeUsers.map((u) => u.id);

    const [lastActivityAt, openByType, recentExceptions, recentLogs] = await Promise.all([
      this.lastOpsActivityByUser(userIds),
      this.prisma.receivingDiscrepancy.groupBy({
        by: ['type'],
        where: { status: 'OPEN' },
        _count: { _all: true },
      }),
      this.prisma.receivingDiscrepancy.findMany({
        where: { status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: {
          session: {
            select: {
              id: true,
              code: true,
              startedBy: true,
              expectedArrival: { select: { code: true, customerName: true } },
            },
          },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { action: { in: OPS_AUDIT_ACTIONS } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { actor: { select: { id: true, name: true, employeeCode: true } } },
      }),
    ]);
    // Recent activity stream (the Live Activity feed, §9) — real audit rows.
    const activity = recentLogs.map((l) => this.toActivityEvent(l as never));

    // ---- exceptions summary (§8) ---------------------------------------
    const severityCounts: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number> = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    for (const row of openByType) severityCounts[exceptionSeverity(row.type)] += row._count._all;

    const workerById = new Map(activeUsers.map((u) => [u.id, u]));
    const recentExceptionsMapped = recentExceptions.map((r) => ({
      id: r.id,
      type: r.type,
      severity: exceptionSeverity(r.type),
      status: r.status,
      reason: r.reason,
      expectedQuantity: r.expectedQuantity,
      actualQuantity: r.actualQuantity,
      difference: r.difference,
      createdAt: r.createdAt,
      session: r.session ? { id: r.session.id, code: r.session.code, arrival: r.session.expectedArrival } : null,
      worker: r.session?.startedBy ? (workerById.get(r.session.startedBy) ?? null) : null,
    }));

    // ---- workers (presence derived from real open work, §6) -------------
    const workerRows = activeUsers.map((u) => {
      const receiving = sessionByWorker.get(u.id);
      const putaway = putawayByWorker.get(u.id);
      const activeTask = receiving
        ? { kind: 'RECEIVING' as const, code: receiving.code, startedAt: receiving.startedAt }
        : putaway
          ? { kind: 'PUTAWAY' as const, code: putaway.code, startedAt: putaway.startedAt }
          : null;
      return {
        id: u.id,
        name: u.name,
        employeeCode: u.employeeCode,
        status: u.status,
        roles: u.roles.map((r) => r.role.name),
        station: u.stationsAssigned[0] ?? null,
        activeTask,
        lastActivityAt: lastActivityAt.get(u.id)?.toISOString() ?? null,
      };
    });

    // ---- station worker task enrichment (derived, not guessed) ----------
    const stationsMapped = stations.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      department: s.department,
      status: s.status,
      capabilities: s.capabilities,
      worker: s.assignedWorker,
      workerTask: s.assignedWorkerId
        ? (() => {
            const r = sessionByWorker.get(s.assignedWorkerId as string);
            const p = putawayByWorker.get(s.assignedWorkerId as string);
            return r ? `RCV ${r.code}` : p ? `PUT ${p.code}` : null;
          })()
        : null,
    }));

    const counters: Record<string, number> = {
      activeSessions: activeSessions.length,
      todaySessions,
      openExceptions: openDiscrepancies,
      expectedArrivals,
      cartonsReceivedToday: cartonsToday,
      correctionsToday: pendingCorrections,
      activeStations: stations.filter((s) => s.status === 'ACTIVE').length,
      stations: stations.length,
      activePutawaySessions: activePutaway.length,
      cartonsStoredToday,
      awaitingPutaway,
      // Fulfillment pipeline
      openOrders,
      articlesAwaitingSorting,
      articlesStored,
      binsReadyForPacking,
      shipmentsReadyToShip,
      shippedToday,
      // V1 control room extra
      piecesStoredToday,
      articlesInCustomerBins,
      articlesAwaitingOrder,
    };

    // COMMAND #1 FINAL — Receiving Containers/Totes and Customer Bins as
    // first-class operational objects on the control room + live article
    // footprint. Container boards derive worker/station/last-activity from
    // real provenance rows — never guessed values.
    const [recvRows, custRows, articlesInOperation, receivingContainersActive] = await Promise.all([
      this.containersBoard({ type: 'RECEIVING', take: 10 }),
      this.containersBoard({ type: 'CUSTOMER', take: 10 }),
      this.prisma.articleUnit.count({
        where: { status: { in: ['RECEIVED', 'IN_CONTAINER', 'STORED', 'IN_CUSTOMER_BIN'] } },
      }),
      this.prisma.operationalContainer.count({ where: { type: 'RECEIVING', status: 'ACTIVE' } }),
    ]);
    counters.activeReceivingContainers = receivingContainersActive;
    counters.articlesInOperation = articlesInOperation;

    return {
      generatedAt: new Date().toISOString(),
      warehouse: warehouse
        ? { id: warehouse.id, code: warehouse.code, name: warehouse.name, status: warehouse.status }
        : null,
      system: { status: 'ONLINE' as const },
      counters,
      receivingContainers: recvRows,
      customerBins: custRows,
      pipeline: this.buildPipeline({
        activeSessions: activeSessions.length,
        arrivalsNotStarted,
        arrivalsInProgress,
        arrivalsReceived,
        sessionsCompletedToday,
        openDiscrepancies,
        toteContainersActive,
        articlesInTotes: articlesAwaitingSorting,
        openOrders,
        articlesAwaitingOrder,
        articlesInCustomerBins,
        customerBinsActive,
        binsReadyForPacking,
        customerBinsDoneToday,
        outboundPackedToday,
        shipmentsReadyToShip,
        shippedToday,
        shippedTotal,
        closedBinsTotal,
      }),
      operations: this.buildOperations({
        activeSessions: activeSessions.length,
        todaySessions,
        cartonsToday,
        openDiscrepancies,
        arrivalsNotStarted,
        articlesAwaitingSorting,
        articlesStored,
        awaitingPutaway,
        openOrders,
        articlesInCustomerBins,
        binsReadyForPacking,
        shipmentsReadyToShip,
        shippedToday,
        activeSessionsList: activeSessions,
      }),
      workers: workerRows,
      exceptions: {
        open: openDiscrepancies,
        bySeverity: severityCounts,
        recent: recentExceptionsMapped,
      },
      activity,
      putawaySessions: activePutaway.map((p) => ({
        id: p.id,
        code: p.code,
        status: p.status,
        startedAt: p.startedAt,
        worker: p.worker,
        stationCode: p.station?.code ?? null,
        placements: p._count.placements,
      })),
      stations: stationsMapped,
      activeSessions: activeSessions.map((s) => ({
        id: s.id,
        code: s.code,
        status: s.status,
        startedAt: s.startedAt,
        arrival: s.expectedArrival,
        stationCode: s.station?.code ?? null,
        worker: s.startedBy ? (workerById.get(s.startedBy) ?? { id: s.startedBy }) : null,
        cartonEvents: s._count.cartons,
        discrepancies: s._count.discrepancies,
      })),
    };
  }

  /** §4B — the operational pipeline (FLOW MODEL PATCH).
   *
   *  ARRIVAL → RECEIVING → RECEIVING CONTAINER / TOTE → CUSTOMER SORTING →
   *  CUSTOMER BIN → PACKING → SHIPPING → ARCHIVE / TRACE.
   *
   *  Category is OPTIONAL product information — never a stage and never a
   *  gate. The Storage path (putaway → storage location) stays a real worker
   *  module but is deliberately NOT in the pipeline: it is not required for
   *  an article to reach its customer bin. Every number is a real count.
   */
  private buildPipeline(d: Record<string, number>): Array<{
    id: string;
    title: string;
    cells: Metric[];
  }> {
    const stages: Array<{
      id: string;
      title: string;
      cells: Array<[string, number | null, string]>;
    }> = [
      {
        id: 'arrival',
        title: 'ARRIVAL',
        cells: [
          ['waiting', d.arrivalsNotStarted, 'arrivals'],
          ['active', d.arrivalsInProgress, 'arrivals'],
          ['done', d.arrivalsReceived, 'arrivals'],
        ],
      },
      {
        id: 'receiving',
        title: 'RECEIVING',
        cells: [
          ['active', d.activeSessions, 'sessions'],
          ['done', d.sessionsCompletedToday, 'sessions'],
          ['exceptions', d.openDiscrepancies, 'open'],
        ],
      },
      {
        id: 'receiving-container',
        title: 'RECEIVING CONTAINER / TOTE',
        cells: [
          ['active', d.toteContainersActive, 'totes'],
          ['waiting', d.articlesInTotes, 'articles'],
        ],
      },
      {
        id: 'customer-sorting',
        title: 'CUSTOMER SORTING',
        cells: [
          ['active', d.openOrders, 'orders'],
          ['waiting', d.articlesAwaitingOrder, 'articles'],
          ['info', d.articlesInCustomerBins, 'in bins'],
        ],
      },
      {
        id: 'customer-bin',
        title: 'CUSTOMER BIN',
        cells: [
          ['active', d.customerBinsActive, 'bins'],
          ['ready', d.binsReadyForPacking, 'bins'],
          ['done', d.customerBinsDoneToday, 'bins'],
        ],
      },
      {
        id: 'packing',
        title: 'PACKING',
        cells: [
          ['waiting', d.binsReadyForPacking, 'bins'],
          ['done', d.outboundPackedToday, 'shipments'],
        ],
      },
      {
        id: 'shipping',
        title: 'SHIPPING',
        cells: [
          ['waiting', d.shipmentsReadyToShip, 'shipments'],
          ['done', d.shippedToday, 'shipments'],
        ],
      },
      {
        id: 'archive-trace',
        title: 'ARCHIVE / TRACE',
        cells: [
          ['done', d.shippedTotal, 'shipments'],
          ['info', d.closedBinsTotal, 'closed bins'],
        ],
      },
    ];

    return stages.map((s) => ({
      id: s.id,
      title: s.title,
      cells: s.cells
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([key, value, unit]) => ({ key, value: value as number, unit })),
    }));
  }

  /** §5 — current operations, one row per operation with [OPEN] targets. */
  private buildOperations(d: Record<string, unknown>): Array<{
    id: string;
    title: string;
    status: { label: string; tone: 'ok' | 'warn' | 'muted' };
    current: number;
    attention: number;
    cells: Metric[];
    open: string | null;
  }> {
    const activeSessionsList = d.activeSessionsList as Array<{ id: string }>;
    const n = (v: unknown) => Number(v) || 0;
    return [
      {
        id: 'receiving',
        title: 'RECEIVING',
        status:
          n(d.activeSessions) > 0
            ? { label: 'RUNNING', tone: 'ok' }
            : n(d.arrivalsNotStarted) > 0
              ? { label: 'STANDBY', tone: 'warn' }
              : { label: 'IDLE', tone: 'muted' },
        current: n(d.activeSessions),
        attention: n(d.openDiscrepancies),
        cells: [
          { key: 'done', value: n(d.todaySessions), unit: 'sessions today' },
          { key: 'info', value: n(d.cartonsToday), unit: 'cartons today' },
        ],
        open: activeSessionsList.length ? `/admin/sessions/${activeSessionsList[0].id}` : null,
      },
      {
        id: 'sorting',
        title: 'SORTING · OPTIONAL PATH',
        status:
          n(d.articlesAwaitingSorting) > 0
            ? { label: 'WORK IN QUEUE', tone: 'warn' }
            : { label: 'EMPTY', tone: 'ok' },
        current: n(d.articlesAwaitingSorting),
        attention: 0,
        cells: [{ key: 'info', value: n(d.articlesAwaitingSorting), unit: 'in totes' }],
        open: '/admin/receiving-containers',
      },
      {
        id: 'storage',
        title: 'STORAGE · OPTIONAL PATH',
        status:
          n(d.awaitingPutaway) > 0
            ? { label: 'WORK IN QUEUE', tone: 'warn' }
            : { label: 'IDLE', tone: 'muted' },
        current: n(d.awaitingPutaway),
        attention: 0,
        cells: [{ key: 'info', value: n(d.articlesStored), unit: 'articles on shelf' }],
        open: null,
      },
      {
        id: 'order-sorting',
        title: 'CUSTOMER ORDER SORTING',
        status:
          n(d.openOrders) > 0
            ? { label: 'ORDERS OPEN', tone: 'ok' }
            : { label: 'NO OPEN ORDERS', tone: 'muted' },
        current: n(d.openOrders),
        attention: 0,
        cells: [{ key: 'info', value: n(d.articlesInCustomerBins), unit: 'articles in bins' }],
        open: '/admin/customer-bins',
      },
      {
        id: 'packing',
        title: 'PACKING',
        status:
          n(d.binsReadyForPacking) > 0
            ? { label: 'BINS READY', tone: 'warn' }
            : { label: 'IDLE', tone: 'muted' },
        current: n(d.binsReadyForPacking),
        attention: 0,
        cells: [],
        open: '/admin/customer-bins',
      },
      {
        id: 'shipping',
        title: 'SHIPPING',
        status:
          n(d.shipmentsReadyToShip) > 0
            ? { label: 'AWAITING DISPATCH', tone: 'warn' }
            : { label: 'CLEAR', tone: 'ok' },
        current: n(d.shipmentsReadyToShip),
        attention: 0,
        cells: [{ key: 'done', value: n(d.shippedToday), unit: 'shipped today' }],
        open: '/admin/shipments',
      },
    ];
  }

  /** Container board row (COMMAND #1 FINAL): a Receiving Tote or a Customer
   *  Bin as a first-class operational object. Worker/station/last activity
   *  are DERIVED from real provenance (the newest receiving session that
   *  scanned articles into a tote; the newest ITEM_PICKED audit on a bin),
   *  never fabricated. FULL is derived: count >= capacity. */
  async containersBoard(input: {
    type: 'RECEIVING' | 'CUSTOMER';
    take?: number;
  }): Promise<
    Array<{
      id: string;
      code: string;
      type: 'RECEIVING' | 'CUSTOMER';
      /** Display status — FULL when a RECEIVING tote reached its capacity. */
      status: string;
      /** Raw DB status, kept so the UI can label honestly. */
      dbStatus: string;
      capacity: number;
      count: number;
      fill: number | null;
      label: string | null;
      order: { id: string; reference: string; customer: string } | null;
      /** Customer bins only: requested units on the linked order. */
      expected: number | null;
      worker: { id: string; name: string; employeeCode: string } | null;
      station: { id: string; code: string; name: string } | null;
      createdAt: string;
      lastActivity: string | null;
    }>
  > {
    const { type, take = 50 } = input;
    const containers = await this.prisma.operationalContainer.findMany({
      where: { type },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take,
      include: {
        order: { select: { id: true, externalOrderReference: true, externalCustomerReference: true } },
        _count: { select: { articles: true } },
      },
    });
    const ids = containers.map((c) => c.id);

    // Newest activity per container from its articles (real provenance).
    const articleRows = ids.length
      ? await this.prisma.articleUnit.findMany({
          where: { containerId: { in: ids } },
          orderBy: { updatedAt: 'desc' },
          take: 2000,
          select: { containerId: true, receivingSessionId: true, updatedAt: true },
        })
      : [];
    const latestByContainer = new Map<string, { sessionId: string | null; at: Date }>();
    for (const a of articleRows) {
      const cur = latestByContainer.get(a.containerId ?? '');
      if (!cur || a.updatedAt > cur.at) {
        latestByContainer.set(a.containerId ?? '', { sessionId: a.receivingSessionId, at: a.updatedAt });
      }
    }
    const sessionIds = Array.from(new Set(
      [...latestByContainer.values()].map((v) => v.sessionId).filter((s): s is string => !!s),
    ));
    const sessions = sessionIds.length
      ? await this.prisma.receivingSession.findMany({
          where: { id: { in: sessionIds } },
          select: {
            id: true,
            code: true,
            startedBy: true,
            startedAt: true,
            station: { select: { id: true, code: true, name: true } },
          },
        })
      : [];
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    const userIds = Array.from(new Set(
      sessions.map((s) => s.startedBy).filter((x): x is string => !!x),
    ));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, employeeCode: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    // Customer bins: expected count = live demand on the order.
    let expectedByOrder = new Map<string, number>();
    // Customer bins: newest sorting worker from the ITEM_PICKED audit trail.
    let pickedByBin = new Map<string, { worker: { id: string; name: string; employeeCode: string }; at: Date }>();
    if (type === 'CUSTOMER') {
      const orderIds = Array.from(new Set(
        containers.map((c) => c.orderId).filter((x): x is string => !!x),
      ));
      if (orderIds.length) {
        const g = await this.prisma.orderItem.groupBy({
          by: ['orderId'],
          where: { orderId: { in: orderIds } },
          _sum: { requestedQuantity: true },
        });
        expectedByOrder = new Map(g.map((r) => [r.orderId, r._sum.requestedQuantity ?? 0]));
      }
      const codes = new Set(containers.map((c) => c.code));
      const audits = codes.size
        ? await this.prisma.auditLog.findMany({
            where: { action: 'ITEM_PICKED' },
            orderBy: { createdAt: 'desc' },
            take: 1000,
            select: {
              createdAt: true,
              actorUserId: true,
              metadata: true,
              actor: { select: { id: true, name: true, employeeCode: true } },
            },
          })
        : [];
      for (const row of audits) {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const binCode = typeof meta.bin === 'string' ? meta.bin : null;
        if (binCode && codes.has(binCode) && !pickedByBin.has(binCode)) {
          pickedByBin.set(binCode, {
            worker: row.actorUserId && row.actor
              ? { id: row.actor.id, name: row.actor.name, employeeCode: row.actor.employeeCode }
              : { id: row.actorUserId ?? 'unknown', name: 'Unknown', employeeCode: '' },
            at: row.createdAt,
          });
        }
      }
    }

    return containers.map((c) => {
      const count = c._count.articles;
      const capacity = c.capacity ?? 50;
      const fill = capacity > 0 ? Math.round((count / capacity) * 100) : null;
      const latest = latestByContainer.get(c.id);
      const session = latest?.sessionId ? sessionById.get(latest.sessionId) : undefined;

      let worker: { id: string; name: string; employeeCode: string } | null = null;
      let station: { id: string; code: string; name: string } | null = null;
      let lastActivity: string | null = null;
      if (type === 'RECEIVING') {
        if (session?.startedBy) worker = userById.get(session.startedBy) ?? null;
        station = session?.station ?? null;
        lastActivity = latest?.at.toISOString() ?? null;
      } else {
        const picked = c.code ? pickedByBin.get(c.code) : undefined;
        if (picked) {
          worker = picked.worker;
          lastActivity = picked.at.toISOString();
        }
        // Bins are not tied to a station by design; leave honest null.
      }
      const isFull = type === 'RECEIVING' && c.status === 'ACTIVE' && fill !== null && fill >= 100;
      return {
        id: c.id,
        code: c.code,
        type: c.type,
        status: isFull ? 'FULL' : c.status,
        dbStatus: c.status,
        capacity,
        count,
        fill,
        label: c.label,
        order: c.order
          ? { id: c.order.id, reference: c.order.externalOrderReference, customer: c.order.externalCustomerReference }
          : null,
        expected: type === 'CUSTOMER' && c.orderId ? (expectedByOrder.get(c.orderId) ?? null) : null,
        worker,
        station,
        createdAt: c.createdAt.toISOString(),
        lastActivity,
      };
    });
  }

  /** Container detail drill-down — contents with full provenance so the
   *  admin can jump Container → Article → Source Carton → Receiving Session
   *  → Customer Order → Bin → Shipment (§ COMMAND #1 FINAL §09). */
  async containerDetail(idOrCode: string) {
    const container = await this.prisma.operationalContainer.findFirst({
      where: { OR: [{ id: idOrCode }, { code: idOrCode.trim().toUpperCase() }] },
      include: {
        order: {
          select: {
            id: true,
            externalOrderReference: true,
            externalCustomerReference: true,
            status: true,
            note: true,
          },
        },
        _count: { select: { articles: true } },
      },
    });
    if (!container) throw new NotFoundException('Container not found.');
    const articles = await this.prisma.articleUnit.findMany({
      where: { containerId: container.id },
      orderBy: { createdAt: 'desc' },
      include: {
        sourceCarton: {
          select: { externalCartonId: true, cartonReference: true, qrCodeValue: true, barcodeValue: true },
        },
        receivingSession: {
          select: { id: true, code: true, status: true, startedAt: true, completedAt: true },
        },
        order: {
          select: { id: true, externalOrderReference: true, externalCustomerReference: true },
        },
        currentLocation: { select: { id: true, locationCode: true } },
        outboundShipment: { select: { id: true, code: true, status: true } },
      },
    });

    // Same derivation as the boards: newest activity/session/worker.
    const latestAt = articles.length
      ? articles.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).updatedAt
      : null;
    const sessions = articles
      .map((a) => a.receivingSessionId)
      .filter((s): s is string => !!s);
    const sessionIds = Array.from(new Set(sessions));
    const sessionRows = sessionIds.length
      ? await this.prisma.receivingSession.findMany({
          where: { id: { in: sessionIds } },
          select: {
            id: true,
            code: true,
            startedBy: true,
            startedAt: true,
            station: { select: { id: true, code: true, name: true } },
          },
        })
      : [];
    const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
    // newest session by article updatedAt
    let newestSessionId: string | null = null;
    let newestAt: Date | null = null;
    for (const a of articles) {
      if (a.receivingSessionId && (!newestAt || a.updatedAt > newestAt)) {
        newestSessionId = a.receivingSessionId;
        newestAt = a.updatedAt;
      }
    }
    const session = newestSessionId ? sessionById.get(newestSessionId) : undefined;
    let worker: { id: string; name: string; employeeCode: string } | null = null;
    if (session?.startedBy) {
      const u = await this.prisma.user.findUnique({
        where: { id: session.startedBy },
        select: { id: true, name: true, employeeCode: true },
      });
      worker = u;
    }
    // Customer bin: sorting worker comes from the ITEM_PICKED trail.
    let sortingWorker: { id: string; name: string; employeeCode: string } | null = null;
    if (container.type === 'CUSTOMER') {
      const audit = await this.prisma.auditLog.findFirst({
        where: { action: 'ITEM_PICKED', metadata: { path: ['bin'], equals: container.code } },
        orderBy: { createdAt: 'desc' },
        select: { actor: { select: { id: true, name: true, employeeCode: true } } },
      });
      sortingWorker = audit?.actor ?? null;
    }

    const count = container._count.articles;
    const capacity = container.capacity ?? 50;
    const isFull = container.type === 'RECEIVING' && container.status === 'ACTIVE' && capacity > 0 && count >= capacity;

    return {
      container: {
        id: container.id,
        code: container.code,
        type: container.type,
        status: isFull ? 'FULL' : container.status,
        dbStatus: container.status,
        capacity,
        count,
        fill: capacity > 0 ? Math.round((count / capacity) * 100) : null,
        label: container.label,
        order: container.order
          ? {
              reference: container.order.externalOrderReference,
              customer: container.order.externalCustomerReference,
              status: container.order.status,
              note: container.order.note,
            }
          : null,
        worker,
        sortingWorker,
        station: session?.station ?? null,
        createdAt: container.createdAt.toISOString(),
        // Closed bins carry no closedAt column yet — CLOSED status + updatedAt
        // are shown instead (honest; not fabricated).
        closedAt: null,
        lastActivity: latestAt ? latestAt.toISOString() : container.updatedAt.toISOString(),
      },
      articles: articles.map((a) => ({
        id: a.id,
        code: a.code,
        sku: a.sku,
        productName: a.productName,
        category: a.category,
        subcategory: a.subcategory,
        categoryStatus: a.categoryStatus,
        status: a.status,
        sourceCarton: a.sourceCarton
          ? {
              code: a.sourceCarton.externalCartonId,
              qr: a.sourceCarton.qrCodeValue ?? a.sourceCarton.barcodeValue ?? null,
            }
          : null,
        receivingSession: a.receivingSession
          ? {
              id: a.receivingSession.id,
              code: a.receivingSession.code,
              status: a.receivingSession.status,
              startedAt: a.receivingSession.startedAt.toISOString(),
              completedAt: a.receivingSession.completedAt?.toISOString() ?? null,
            }
          : null,
        order: a.order
          ? {
              id: a.order.id,
              reference: a.order.externalOrderReference,
              customer: a.order.externalCustomerReference,
            }
          : null,
        currentLocation: a.currentLocation
          ? { locationCode: a.currentLocation.locationCode }
          : null,
        outboundShipment: a.outboundShipment
          ? { code: a.outboundShipment.code, status: a.outboundShipment.status }
          : null,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }

  /** §9 — Live Activity feed (longer stream for the dedicated board). */
  async activity(limit = 50) {
    const take = Math.min(Math.max(1, Math.floor(limit)), 100);
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { in: OPS_AUDIT_ACTIONS } },
      orderBy: { createdAt: 'desc' },
      take,
      include: { actor: { select: { id: true, name: true, employeeCode: true } } },
    });
    return rows.map((r) => this.toActivityEvent(r as never));
  }

  private toActivityEvent(row: {
    id: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
    createdAt: Date;
    metadata: Record<string, unknown> | null;
    actor: { id: string; name: string; employeeCode: string } | null;
  }) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    let entity: string | null = null;
    for (const key of ENTITY_CODE_KEYS) {
      const v = meta[key];
      if (typeof v === 'string' && v) {
        entity = v;
        break;
      }
    }
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      action: row.action,
      entityType: row.entityType,
      entity: entity ?? null,
      worker: row.actor ? { id: row.actor.id, name: row.actor.name, employeeCode: row.actor.employeeCode } : null,
    };
  }

  /** Workers with their operational footprint (§37) + live task (§6). */
  async workers() {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
        stationsAssigned: { select: { id: true, code: true, name: true, department: true } },
      },
    });

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const userIds = users.map((u) => u.id);
    const [grouped, openReceiving, openPutaway] = await Promise.all([
      this.prisma.receivingSession.groupBy({
        by: ['startedBy'],
        where: { startedAt: { gte: since } },
        _count: { _all: true },
      }),
      userIds.length
        ? this.prisma.receivingSession.findMany({
            where: { status: { in: ['RECEIVING', 'PAUSED'] }, startedBy: { in: userIds } },
            select: { startedBy: true, code: true, startedAt: true },
          })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.putawaySession.findMany({
            where: { status: { in: ['ACTIVE', 'PAUSED'] }, workerId: { in: userIds } },
            select: { workerId: true, code: true, startedAt: true },
          })
        : Promise.resolve([]),
    ]);
    const countByWorker = new Map(grouped.map((g) => [g.startedBy, g._count._all]));
    const taskByUser = new Map<string, { kind: 'RECEIVING' | 'PUTAWAY'; code: string; startedAt: Date }>();
    for (const s of openReceiving) {
      if (s.startedBy) taskByUser.set(s.startedBy, { kind: 'RECEIVING', code: s.code, startedAt: s.startedAt });
    }
    for (const p of openPutaway) {
      if (p.workerId) taskByUser.set(p.workerId, { kind: 'PUTAWAY', code: p.code, startedAt: p.startedAt });
    }
    const lastAt = await this.lastOpsActivityByUser(userIds);

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      employeeCode: u.employeeCode,
      status: u.status,
      roles: u.roles.map((r) => r.role.name),
      station: u.stationsAssigned[0] ?? null,
      sessionsToday: countByWorker.get(u.id) ?? 0,
      activeTask: taskByUser.get(u.id) ?? null,
      lastActivityAt: lastAt.get(u.id)?.toISOString() ?? null,
    }));
  }

  /** Workforce → Tasks board: canonical registry + real floor numbers. */
  async taskBoard() {
    const [stationsByDept, activeByDept, receivingOpen, putawayOpen] = await Promise.all([
      this.prisma.station.groupBy({ by: ['department'], _count: { _all: true } }),
      this.prisma.station.groupBy({
        by: ['department'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.receivingSession.count({ where: { status: { in: ['RECEIVING', 'PAUSED'] } } }),
      this.prisma.putawaySession.count({ where: { status: { in: ['ACTIVE', 'PAUSED'] } } }),
    ]);
    const stationsByDeptMap = new Map(stationsByDept.map((s) => [s.department, s._count._all]));
    const activeByDeptMap = new Map(activeByDept.map((s) => [s.department, s._count._all]));

    const tasks = await Promise.all(
      TASK_REGISTRY.map(async (t) => {
        const executors = await this.prisma.user.count({
          where: {
            status: 'ACTIVE',
            roles: { some: { role: { permissions: { some: { permission: { key: t.permission } } } } } },
          },
        });
        return {
          key: t.key,
          label: t.label,
          path: t.path,
          department: t.department,
          permission: t.permission,
          ready: t.ready,
          executors,
          stations: stationsByDeptMap.get(t.department as never) ?? 0,
          activeStations: activeByDeptMap.get(t.department as never) ?? 0,
          open:
            t.key === 'receiving' ? receivingOpen : t.key === 'putaway' ? putawayOpen : null,
        };
      }),
    );
    return tasks;
  }

  /** Drill-down: one worker and their sessions (§37). */
  async worker(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
        stationsAssigned: { select: { id: true, code: true, name: true, department: true } },
      },
    });
    if (!user) throw new NotFoundException('Worker not found.');

    // A worker's history spans every task they perform, not just receiving.
    const [sessions, putawaySessions] = await Promise.all([
      this.prisma.receivingSession.findMany({
        where: { startedBy: id },
        orderBy: { startedAt: 'desc' },
        take: 50,
        include: {
          expectedArrival: { select: { id: true, code: true, customerName: true } },
          _count: { select: { cartons: true, products: true, discrepancies: true } },
        },
      }),
      this.prisma.putawaySession.findMany({
        where: { workerId: id },
        orderBy: { startedAt: 'desc' },
        take: 50,
        include: {
          station: { select: { code: true } },
          _count: { select: { placements: true } },
        },
      }),
    ]);

    return {
      worker: {
        id: user.id,
        name: user.name,
        employeeCode: user.employeeCode,
        status: user.status,
        roles: user.roles.map((r) => r.role.name),
        station: user.stationsAssigned[0] ?? null,
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        code: s.code,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        arrival: s.expectedArrival,
        counts: s._count,
      })),
      putawaySessions: putawaySessions.map((p) => ({
        id: p.id,
        code: p.code,
        status: p.status,
        startedAt: p.startedAt,
        completedAt: p.completedAt,
        stationCode: p.station?.code ?? null,
        placements: p._count.placements,
      })),
    };
  }

  /**
   * Full operational timeline of one session (§37).
   * Every carton event, product line, discrepancy and correction, merged into
   * a single chronological list so an admin can reconstruct what happened.
   */
  async session(id: string) {
    const session = await this.prisma.receivingSession.findFirst({
      where: { OR: [{ id }, { code: id.toUpperCase() }] },
      include: {
        expectedArrival: true,
        shipment: true,
        station: { select: { id: true, code: true, name: true, department: true } },
        cartons: { include: { carton: true }, orderBy: { createdAt: 'asc' } },
        products: { orderBy: { createdAt: 'asc' } },
        discrepancies: { orderBy: { createdAt: 'asc' } },
        corrections: {
          orderBy: { createdAt: 'asc' },
          include: { admin: { select: { id: true, name: true, employeeCode: true } } },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found.');

    const worker = session.startedBy
      ? await this.prisma.user.findUnique({
          where: { id: session.startedBy },
          select: { id: true, name: true, employeeCode: true },
        })
      : null;

    type Event = {
      at: Date;
      kind: string;
      label: string;
      detail: Record<string, unknown>;
    };
    const timeline: Event[] = [];

    timeline.push({
      at: session.startedAt,
      kind: 'SESSION_START',
      label: `Session ${session.code} started`,
      detail: {
        arrival: session.expectedArrival?.code,
        device: session.deviceType,
        station: session.station?.code ?? null,
      },
    });

    for (const c of session.cartons) {
      timeline.push({
        at: c.receivedAt ?? c.createdAt,
        kind: c.status === 'REVERSED' ? 'CARTON_REVERSED' : 'CARTON',
        label: `${c.scannedCode} ${c.status}`,
        detail: { code: c.scannedCode, status: c.status, source: c.source, scanType: c.scanType },
      });
    }
    for (const p of session.products) {
      timeline.push({
        at: p.updatedAt,
        kind: 'PRODUCT',
        label: `${p.sku ?? p.reference ?? 'unknown'} ${p.receivedQuantity}/${p.expectedQuantity}`,
        detail: { sku: p.sku, received: p.receivedQuantity, expected: p.expectedQuantity, status: p.status },
      });
    }
    for (const d of session.discrepancies) {
      timeline.push({
        at: d.createdAt,
        kind: 'EXCEPTION',
        label: `${d.type} (${d.status})`,
        detail: { id: d.id, type: d.type, status: d.status, reason: d.reason },
      });
    }
    for (const c of session.corrections) {
      timeline.push({
        at: c.createdAt,
        kind: 'CORRECTION',
        label: `${c.code} ${c.action}`,
        detail: { code: c.code, action: c.action, reason: c.reason, admin: c.admin?.name },
      });
    }
    if (session.completedAt) {
      timeline.push({
        at: session.completedAt,
        kind: 'SESSION_END',
        label: `Session ${session.code} completed`,
        detail: {},
      });
    }

    timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      session: {
        id: session.id,
        code: session.code,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        deviceType: session.deviceType,
        arrival: session.expectedArrival,
        shipment: session.shipment,
        station: session.station,
        worker,
      },
      cartons: session.cartons,
      products: session.products,
      discrepancies: session.discrepancies,
      corrections: session.corrections,
      timeline,
    };
  }

  /** Exception Center feed (§38) — each row carries its severity policy. */
  async exceptions(status: 'OPEN' | 'RESOLVED' | 'REJECTED' | 'ALL' = 'OPEN') {
    const rows = await this.prisma.receivingDiscrepancy.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        session: {
          select: {
            id: true,
            code: true,
            startedBy: true,
            expectedArrival: { select: { code: true, customerName: true } },
          },
        },
      },
    });

    const workerIds = [...new Set(rows.map((r) => r.session?.startedBy).filter(Boolean))] as string[];
    const workers = workerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: workerIds } },
          select: { id: true, name: true, employeeCode: true },
        })
      : [];
    const byId = new Map(workers.map((w) => [w.id, w]));

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: exceptionSeverity(r.type),
      status: r.status,
      reason: r.reason,
      expectedQuantity: r.expectedQuantity,
      actualQuantity: r.actualQuantity,
      difference: r.difference,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      resolution: r.resolution,
      session: r.session ? { id: r.session.id, code: r.session.code, arrival: r.session.expectedArrival } : null,
      worker: r.session?.startedBy ? (byId.get(r.session.startedBy) ?? null) : null,
    }));
  }
}
