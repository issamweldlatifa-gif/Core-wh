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
      sessionsCompletedToday,
      toteContainersActive,
      needsReviewAwaiting,
      piecesStoredToday,
      articlesAwaitingOrder,
      articlesInCustomerBins,
      customerBinsActive,
      customerBinsDoneToday,
      outboundPackedToday,
      activeCategoryCount,
      destinationCount,
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
      this.prisma.receivingSession.count({
        where: {
          status: { in: ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'] },
          completedAt: { gte: since },
        },
      }),
      this.prisma.operationalContainer.count({ where: { type: 'RECEIVING', status: 'ACTIVE' } }),
      this.prisma.articleUnit.count({
        where: { status: 'IN_CONTAINER', categoryStatus: 'NEEDS_REVIEW' },
      }),
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
      this.prisma.categoryMaster.count({ where: { status: 'ACTIVE' } }),
      this.prisma.categoryZoneMapping.count(),
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

    const counters = {
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

    return {
      generatedAt: new Date().toISOString(),
      warehouse: warehouse
        ? { id: warehouse.id, code: warehouse.code, name: warehouse.name, status: warehouse.status }
        : null,
      system: { status: 'ONLINE' as const },
      counters,
      pipeline: this.buildPipeline({
        activeSessions: activeSessions.length,
        arrivalsNotStarted,
        sessionsCompletedToday,
        openDiscrepancies,
        toteContainersActive,
        articlesAwaitingSorting,
        needsReviewAwaiting,
        piecesStoredToday,
        activePutaway: activePutaway.length,
        awaitingPutaway,
        cartonsStoredToday,
        articlesStored,
        openOrders,
        articlesAwaitingOrder,
        articlesInCustomerBins,
        customerBinsActive,
        binsReadyForPacking,
        customerBinsDoneToday,
        outboundPackedToday,
        shipmentsReadyToShip,
        shippedToday,
        activeCategoryCount,
        destinationCount,
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

  /** §4B — the 8-step operational pipeline with real per-stage metrics. */
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
        id: 'receiving',
        title: 'RECEIVING',
        cells: [
          ['active', d.activeSessions, 'sessions'],
          ['waiting', d.arrivalsNotStarted, 'arrivals'],
          ['done', d.sessionsCompletedToday, 'sessions'],
          ['exceptions', d.openDiscrepancies, 'open'],
        ],
      },
      {
        id: 'receiving-totes',
        title: 'RECEIVING TOTES',
        cells: [
          ['active', d.toteContainersActive, 'totes'],
          ['waiting', d.articlesAwaitingSorting, 'articles'],
        ],
      },
      {
        id: 'category-sorting',
        title: 'CATEGORY SORTING',
        cells: [
          ['waiting', d.articlesAwaitingSorting, 'articles'],
          ['attention', d.needsReviewAwaiting, 'articles'],
          ['done', d.piecesStoredToday, 'pieces'],
        ],
      },
      {
        id: 'storage',
        title: 'STORAGE',
        cells: [
          ['active', d.activePutaway, 'putaway'],
          ['waiting', d.awaitingPutaway, 'cartons'],
          ['done', d.cartonsStoredToday, 'cartons'],
          ['info', d.articlesStored, 'on shelf'],
        ],
      },
      {
        id: 'order-sorting',
        title: 'CUSTOMER ORDER SORTING',
        cells: [
          ['active', d.openOrders, 'orders'],
          ['waiting', d.articlesAwaitingOrder, 'articles'],
          ['info', d.articlesInCustomerBins, 'in bins'],
        ],
      },
      {
        id: 'customer-bins',
        title: 'CUSTOMER BINS',
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
        title: 'SORTING',
        status:
          n(d.articlesAwaitingSorting) > 0
            ? { label: 'WORK IN QUEUE', tone: 'warn' }
            : { label: 'EMPTY', tone: 'ok' },
        current: n(d.articlesAwaitingSorting),
        attention: 0,
        cells: [{ key: 'info', value: n(d.articlesAwaitingSorting), unit: 'in totes' }],
        open: '/admin/traceability',
      },
      {
        id: 'storage',
        title: 'STORAGE',
        status:
          n(d.awaitingPutaway) > 0
            ? { label: 'WORK IN QUEUE', tone: 'warn' }
            : { label: 'IDLE', tone: 'muted' },
        current: n(d.awaitingPutaway),
        attention: 0,
        cells: [{ key: 'info', value: n(d.articlesStored), unit: 'articles on shelf' }],
        open: '/admin/traceability',
      },
      {
        id: 'order-sorting',
        title: 'ORDER SORTING',
        status:
          n(d.openOrders) > 0
            ? { label: 'ORDERS OPEN', tone: 'ok' }
            : { label: 'NO OPEN ORDERS', tone: 'muted' },
        current: n(d.openOrders),
        attention: 0,
        cells: [{ key: 'info', value: n(d.articlesInCustomerBins), unit: 'articles in bins' }],
        open: '/admin/orders',
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
        open: '/admin/orders',
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
