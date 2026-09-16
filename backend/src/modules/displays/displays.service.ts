import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash, randomBytes } from 'crypto';

/**
 * Station Display Mode (owner order 2026-09-16).
 *
 * A StationDisplay is a READ-ONLY live view bound to one station. The token
 * in the public URL is the display's ONLY credential (256-bit hex) and grants
 * nothing beyond reading/streaming that station's view — no admin and no
 * worker authority ever travels with it. All data comes from the same tables
 * the CT40 transactions write, so the display shows the very same
 * transactions (same ids) — it never creates or mirrors any.
 */

/** Visibility switches (§4 Data Visibility). `reports` stays off in v1. */
export const DISPLAY_CONFIG_FIELDS = [
  'worker',
  'operation',
  'task',
  'lastScan',
  'product',
  'customer',
  'quantity',
  'status',
  'progress',
  'station',
  'recent',
  'reports',
] as const;

export type DisplayConfigField = (typeof DISPLAY_CONFIG_FIELDS)[number];

export const DEFAULT_DISPLAY_CONFIG: Record<DisplayConfigField, boolean> = {
  worker: true,
  operation: true,
  task: true,
  lastScan: true,
  product: true,
  customer: true,
  quantity: true,
  status: true,
  progress: true,
  station: true,
  // Recent-actions feed (owner request 2026-09-16: the display shows ALL the
  // actions, not only the last scan).
  recent: true,
  reports: false,
};

/** A display that has not hit the API for this long shows as Offline. */
export const DISPLAY_OFFLINE_AFTER_MS = 90_000;

export function generateDisplayToken(): string {
  return randomBytes(32).toString('hex');
}

/** Keep only known keys, coerce to boolean, fill defaults. Unknown keys are dropped. */
export function normalizeDisplayConfig(input: unknown): Record<DisplayConfigField, boolean> {
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_DISPLAY_CONFIG };
  for (const key of DISPLAY_CONFIG_FIELDS) {
    if (key in raw) out[key] = raw[key] === true;
  }
  return out;
}

/** True when the raw snapshot section changed — used to skip no-op SSE pushes. */
export function snapshotFingerprint(raw: unknown): string {
  return createHash('sha1').update(JSON.stringify(raw ?? null)).digest('hex');
}

@Injectable()
export class DisplaysService {
  private readonly logger = new Logger(DisplaysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------
  // Admin CRUD (audit-logged). Token values are returned only here.
  // ------------------------------------------------------------------

  async create(stationId: string, input: { name?: string; config?: unknown }, actorUserId: string | null) {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } });
    if (!station) return null;
    const displayName = input.name?.trim() || `${station.name} Display`;
    const row = await this.prisma.stationDisplay.create({
      data: {
        stationId,
        name: displayName,
        accessToken: generateDisplayToken(),
        config: normalizeDisplayConfig(input.config),
      },
    });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_CREATED',
      entityType: 'station_display',
      entityId: row.id,
      metadata: { stationId, name: displayName, displayType: row.displayType },
    });
    return row;
  }

  listForStation(stationId: string) {
    return this.prisma.stationDisplay.findMany({
      where: { stationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async update(
    id: string,
    input: { name?: string; enabled?: boolean; config?: unknown; stationId?: string },
    actorUserId: string | null,
  ) {
    const before = await this.prisma.stationDisplay.findUnique({ where: { id } });
    if (!before) return null;

    const data: { name?: string; enabled?: boolean; config?: Record<DisplayConfigField, boolean>; stationId?: string } = {};
    if (typeof input.name === 'string' && input.name.trim()) data.name = input.name.trim();
    if (typeof input.enabled === 'boolean') data.enabled = input.enabled;
    if (input.config !== undefined) data.config = normalizeDisplayConfig(input.config);
    if (typeof input.stationId === 'string' && input.stationId !== before.stationId) {
      const target = await this.prisma.station.findUnique({ where: { id: input.stationId } });
      if (!target) return { error: 'STATION_NOT_FOUND' as const };
      data.stationId = input.stationId;
    }

    const row = await this.prisma.stationDisplay.update({ where: { id }, data });

    if (data.stationId) {
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_STATION_CHANGED',
        entityType: 'station_display',
        entityId: id,
        metadata: { from: before.stationId, to: data.stationId, name: row.name },
      });
    }
    if (typeof input.enabled === 'boolean' && input.enabled !== before.enabled) {
      await this.audit.log({
        actorUserId,
        action: input.enabled ? 'DISPLAY_ENABLED' : 'DISPLAY_DISABLED',
        entityType: 'station_display',
        entityId: id,
        metadata: { stationId: row.stationId, name: row.name, previousValue: before.enabled, newValue: input.enabled },
      });
    }
    if (data.name || data.config) {
      await this.audit.log({
        actorUserId,
        action: 'DISPLAY_UPDATED',
        entityType: 'station_display',
        entityId: id,
        metadata: {
          stationId: row.stationId,
          name: row.name,
          ...(data.name ? { previousName: before.name } : {}),
          ...(data.config ? { config: data.config } : {}),
        },
      });
    }
    return { row };
  }

  async regenerate(id: string, actorUserId: string | null) {
    const before = await this.prisma.stationDisplay.findUnique({ where: { id } });
    if (!before) return null;
    const accessToken = generateDisplayToken();
    const row = await this.prisma.stationDisplay.update({ where: { id }, data: { accessToken } });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_ACCESS_REGENERATED',
      entityType: 'station_display',
      entityId: id,
      metadata: { stationId: row.stationId, name: row.name },
    });
    return row;
  }

  async remove(id: string, actorUserId: string | null) {
    const before = await this.prisma.stationDisplay.findUnique({ where: { id } });
    if (!before) return null;
    await this.prisma.stationDisplay.delete({ where: { id } });
    await this.audit.log({
      actorUserId,
      action: 'DISPLAY_DELETED',
      entityType: 'station_display',
      entityId: id,
      metadata: { stationId: before.stationId, name: before.name },
    });
    return before;
  }

  // ------------------------------------------------------------------
  // Public display view (token = the only credential). READ-ONLY.
  // ------------------------------------------------------------------

  /** null → unknown token; { enabled: false } → disabled by admin (no data leaves). */
  async snapshotForToken(token: string) {
    const display = await this.prisma.stationDisplay.findUnique({
      where: { accessToken: token },
      include: { station: true },
    });
    if (!display) return null;
    if (!display.enabled) return { enabled: false as const, display: { name: display.name } };

    const raw = await this.buildStationSnapshot(display.stationId);
    return {
      enabled: true as const,
      display: { name: display.name, type: display.displayType },
      stationName: display.station.name,
      ...filterSnapshotByConfig(raw, display.config),
      lastUpdate: new Date().toISOString(),
    };
  }

  async touch(token: string) {
    try {
      await this.prisma.stationDisplay.updateMany({ where: { accessToken: token }, data: { lastSeenAt: new Date() } });
    } catch (e) {
      this.logger.warn(`display touch failed: ${e}`);
    }
  }

  /** Minimal metadata for liveness checks — no snapshot payload. */
  async listTokenMeta(token: string) {
    return this.prisma.stationDisplay.findUnique({
      where: { accessToken: token },
      select: { id: true, enabled: true, lastSeenAt: true },
    });
  }

  /**
   * Build the raw station view from the SAME tables the worker transactions
   * write (receiving sessions/scan events/discrepancies, temporary-storage
   * items, task assignments, station assignment). Never mutates anything.
   */
  async buildStationSnapshot(stationId: string) {
    const station = await this.prisma.station.findUnique({
      where: { id: stationId },
      include: { assignedWorker: { select: { id: true, name: true, employeeCode: true } } },
    });
    if (!station) return { station: null };

    const sessionInclude = {
      _count: { select: { scanEvents: true } },
    } as const;

    const [activeSession, lastTsItem, openTask] = await Promise.all([
      this.prisma.receivingSession.findFirst({
        where: { stationId, status: { in: ['RECEIVING', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        include: sessionInclude,
      }),
      this.prisma.temporaryStorageItem.findFirst({
        where: { stationId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workerTaskAssignment.findFirst({
        where: { stationId, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Fallback context when nothing is active right now: the most recent
    // session of the day keeps the "last scan" alive instead of blanking.
    const contextSession =
      activeSession ??
      (await this.prisma.receivingSession.findFirst({
        where: { stationId, startedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        orderBy: { startedAt: 'desc' },
        include: sessionInclude,
      }));

    // arrivalId is a convention reference (no Prisma relation) — load it apart.
    const arrival = contextSession
      ? await this.prisma.expectedArrival.findUnique({
          where: { id: contextSession.arrivalId },
          select: { code: true, customerName: true, customerSurname: true, storeName: true, arrivalReference: true },
        })
      : null;

    const [lastScanEvent, lastCartonEvent, openDiscrepancy, products] = await Promise.all([
      contextSession
        ? this.prisma.receivingScanEvent.findFirst({ where: { sessionId: contextSession.id }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
      contextSession
        ? this.prisma.receivingCarton.findFirst({ where: { receivingSessionId: contextSession.id }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
      contextSession
        ? this.prisma.receivingDiscrepancy.findFirst({ where: { receivingSessionId: contextSession.id, status: 'OPEN' }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve(null),
      contextSession
        ? this.prisma.receivingProduct.findMany({ where: { receivingSessionId: contextSession.id }, select: { expectedQuantity: true, receivedQuantity: true } })
        : Promise.resolve([] as Array<{ expectedQuantity: number; receivedQuantity: number }>),
    ]);

    // ---- BATCH activity (owner report 2026-09-16: BATCH station displays
    // showed nothing). Batch writes carry NO stationId (addUnit/receiveUnit
    // only stamp the worker), so bind via the station's ASSIGNED WORKER —
    // the existing Worker+Device+Station assignment, never hard-coded ids.
    const workerId = station.assignedWorkerId;
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [lastBatchUnit, lastReceivedItem, workerBatch] = workerId
      ? await Promise.all([
          this.prisma.ayroviUnit.findFirst({
            where: { createdByWorkerId: workerId, createdAt: { gte: dayAgo } },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.batchItem.findFirst({
            where: { scannedByWorkerId: workerId, status: 'RECEIVED', batch: { updatedAt: { gte: dayAgo } } },
            include: { unit: true, batch: true },
            orderBy: { createdAt: 'desc' },
          }),
          this.prisma.batch.findFirst({
            where: {
              OR: [{ createdById: workerId }, { items: { some: { scannedByWorkerId: workerId } } }],
              status: { in: ['CREATED', 'RECEIVING_IN_PROGRESS'] },
            },
            orderBy: { updatedAt: 'desc' },
          }),
        ])
      : ([null, null, null] as [null, null, null]);

    /** Display code for a batch unit: the ORIGINAL identity, AYP as fallback. */
    const unitCode = (u: { code: string; originalBarcode: string | null; originalSku: string | null; originalReference: string | null }) =>
      u.originalBarcode ?? u.originalSku ?? u.originalReference ?? u.code;

    // ---- Recent-actions feed (owner request 2026-09-16): ALL recent
    // actions at this station, newest first — receiving scans + cartons,
    // batch units (worker-bound), batch receives, TS puts. Same tables,
    // read-only, capped.
    const stationSessionIds = await this.prisma.receivingSession.findMany({
      where: { stationId, startedAt: { gte: dayAgo } },
      select: { id: true },
      take: 20,
    });
    const sessIds = stationSessionIds.map((r) => r.id);
    const [rxScans, rxCartons, batchUnits, batchReceives, tsItems] = await Promise.all([
      sessIds.length
        ? this.prisma.receivingScanEvent.findMany({ where: { sessionId: { in: sessIds }, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      sessIds.length
        ? this.prisma.receivingCarton.findMany({ where: { receivingSessionId: { in: sessIds }, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      workerId
        ? this.prisma.ayroviUnit.findMany({ where: { createdByWorkerId: workerId, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      workerId
        ? this.prisma.batchItem.findMany({ where: { scannedByWorkerId: workerId, status: 'RECEIVED', receivedAt: { gte: dayAgo } }, include: { unit: true }, orderBy: { receivedAt: 'desc' }, take: 12 })
        : Promise.resolve([]),
      this.prisma.temporaryStorageItem.findMany({ where: { stationId, createdAt: { gte: dayAgo } }, orderBy: { createdAt: 'desc' }, take: 12 }),
    ]);
    type RecentAction = {
      id: string; kind: string; code: string | null; productName: string | null;
      customerName: string | null; quantity: number; status: string; at: Date;
    };
    const recent: RecentAction[] = [
      ...rxScans.map((e) => ({ id: e.id, kind: e.kind === 'ARTICLE' ? 'ARTICLE' : 'SCAN', code: e.code ?? null, productName: null, customerName: null, quantity: e.quantity, status: 'CONFIRMED', at: e.createdAt })),
      ...rxCartons.map((c) => ({ id: c.id, kind: 'CARTON', code: c.scannedCode, productName: null, customerName: null, quantity: 1, status: c.status, at: c.receivedAt ?? c.createdAt })),
      ...batchUnits.map((u) => ({ id: u.id, kind: 'BATCH UNIT', code: unitCode(u), productName: null, customerName: null, quantity: 1, status: 'REGISTERED', at: u.createdAt })),
      ...batchReceives.map((bi) => ({ id: bi.id, kind: 'BATCH RECEIVE', code: unitCode(bi.unit), productName: null, customerName: null, quantity: 1, status: 'RECEIVED', at: bi.receivedAt ?? bi.createdAt })),
      ...tsItems.map((t) => ({ id: t.id, kind: 'STORAGE', code: t.sku ?? t.reference ?? null, productName: t.productName ?? null, customerName: t.customerName ?? null, quantity: t.quantity, status: t.status, at: t.createdAt })),
    ]
      .sort((a, b) => +new Date(b.at) - +new Date(a.at))
      .slice(0, 10);

    // The station's live operation = whichever moved most recently: a
    // receiving session or the worker's batch (build / receiving).
    const batchActive =
      workerBatch && (!activeSession || +new Date(workerBatch.updatedAt) > +new Date(activeSession.startedAt))
        ? workerBatch
        : null;

    const expectedTotal = products.reduce((n, p) => n + p.expectedQuantity, 0);
    const receivedTotal = products.reduce((n, p) => n + p.receivedQuantity, 0);

    // Prefer the newest of (receiving scan, batch unit, batch receive, TS
    // put, carton) as the "last scan" — one physical scan = one visible pop.
    const batchUnitCandidate = lastBatchUnit
      ? {
          id: lastBatchUnit.id,
          kind: 'BATCH UNIT' as const,
          code: unitCode(lastBatchUnit),
          productName: null as string | null,
          customerName: null as string | null,
          quantity: 1,
          status: 'REGISTERED',
          at: lastBatchUnit.createdAt,
        }
      : null;
    const batchReceiveCandidate = lastReceivedItem
      ? {
          id: lastReceivedItem.id,
          kind: 'BATCH RECEIVE' as const,
          code: unitCode(lastReceivedItem.unit),
          productName: null as string | null,
          customerName: null as string | null,
          quantity: 1,
          status: 'RECEIVED',
          at: (lastReceivedItem as { receivedAt?: Date | null }).receivedAt ?? lastReceivedItem.batch.updatedAt,
        }
      : null;
    const tsCandidate = lastTsItem
      ? {
          id: lastTsItem.id,
          kind: 'STORAGE' as const,
          code: lastTsItem.sku ?? lastTsItem.reference ?? null,
          productName: lastTsItem.productName ?? null,
          customerName: lastTsItem.customerName ?? null,
          quantity: lastTsItem.quantity,
          status: lastTsItem.status,
          at: lastTsItem.createdAt,
        }
      : null;
    const rxCandidate = lastScanEvent
      ? {
          id: lastScanEvent.id,
          kind: lastScanEvent.kind as string,
          code: lastScanEvent.code,
          productName: null as string | null,
          customerName: null as string | null,
          quantity: lastScanEvent.quantity,
          status: 'CONFIRMED',
          at: lastScanEvent.createdAt,
        }
      : null;
    const lastCarton = lastCartonEvent
      ? {
          id: lastCartonEvent.id,
          kind: 'CARTON' as const,
          code: lastCartonEvent.scannedCode,
          productName: null as string | null,
          customerName: null as string | null,
          quantity: 1,
          status: lastCartonEvent.status,
          at: lastCartonEvent.receivedAt ?? lastCartonEvent.createdAt,
        }
      : null;
    const lastScan = [rxCandidate, batchUnitCandidate, batchReceiveCandidate, tsCandidate, lastCarton]
      .filter(Boolean)
      .sort((a, b) => +new Date(b!.at) - +new Date(a!.at))[0] ?? null;

    const batchProgress =
      batchActive && batchActive.status === 'RECEIVING_IN_PROGRESS' && batchActive.totalExpected > 0
        ? { done: batchActive.totalScanned, total: batchActive.totalExpected, label: 'units' }
        : null;

    return {
      station: {
        code: station.code,
        name: station.name,
        department: station.department,
        status: station.status,
      },
      worker: station.assignedWorker
        ? { code: station.assignedWorker.employeeCode, name: station.assignedWorker.name }
        : null,
      operation: batchActive
        ? {
            label: batchActive.status === 'CREATED' ? 'BATCH BUILD' : 'BATCH RECEIVING',
            sessionCode: batchActive.batchCode,
            sessionStatus: batchActive.status,
            arrivalReference: null,
          }
        : activeSession
          ? {
              label: 'RECEIVING',
              sessionCode: activeSession.code,
              sessionStatus: activeSession.status,
              arrivalReference: arrival?.arrivalReference ?? arrival?.code ?? null,
            }
          : lastTsItem
            ? { label: 'TEMPORARY_STORAGE', sessionCode: null, sessionStatus: null, arrivalReference: null }
            : null,
      task: openTask ? { title: openTask.title, status: openTask.status } : null,
      lastScan,
      error: openDiscrepancy
        ? { type: openDiscrepancy.type, reason: openDiscrepancy.reason, at: openDiscrepancy.createdAt }
        : null,
      customer: arrival
        ? [arrival.customerName, arrival.customerSurname].filter(Boolean).join(' ').trim() || null
        : lastTsItem?.customerName ?? null,
      progress: batchProgress ?? (expectedTotal > 0 || receivedTotal > 0
        ? { done: receivedTotal, total: Math.max(expectedTotal, receivedTotal), label: 'units' }
        : null),
      recent,
      scanCount: batchActive && batchActive.status === 'CREATED' ? batchActive.totalExpected : activeSession?._count.scanEvents ?? 0,
    };
  }
}

/**
 * SERVER-side visibility enforcement (§4/§7): hidden fields never leave the
 * API, so the browser cannot reveal them by inspecting the payload.
 */
export function filterSnapshotByConfig(raw: any, config: unknown) {
  const cfg = normalizeDisplayConfig(config);
  const out: Record<string, unknown> = {};
  if (cfg.station && raw?.station) out.station = raw.station;
  if (cfg.worker) out.worker = raw?.worker ?? null;
  if (cfg.operation) out.operation = raw?.operation ?? null;
  if (cfg.task) out.task = raw?.task ?? null;
  if (cfg.progress) out.progress = raw?.progress ?? null;
  if (cfg.reports) out.reports = raw?.reports ?? null; // v1: off by default
  if (cfg.lastScan && raw?.lastScan) {
    const s = raw.lastScan;
    out.lastScan = {
      id: s.id,
      kind: s.kind,
      at: s.at,
      ...(cfg.product ? { code: s.code ?? null, productName: s.productName ?? null } : {}),
      ...(cfg.customer ? { customerName: s.customerName ?? null } : {}),
      ...(cfg.quantity ? { quantity: s.quantity } : {}),
      ...(cfg.status ? { status: s.status } : {}),
    };
  } else {
    out.lastScan = null;
  }
  if (cfg.status) out.error = raw?.error ?? null;
  if (cfg.recent && Array.isArray(raw?.recent)) {
    out.recent = (raw.recent as Array<Record<string, unknown>>).slice(0, 10).map((r) => ({
      id: r.id,
      kind: r.kind,
      at: r.at,
      ...(cfg.product ? { code: r.code ?? null, productName: r.productName ?? null } : {}),
      ...(cfg.customer ? { customerName: r.customerName ?? null } : {}),
      ...(cfg.quantity ? { quantity: r.quantity } : {}),
      ...(cfg.status ? { status: r.status } : {}),
    }));
  }
  out.customer = cfg.customer ? raw?.customer ?? null : null;
  return out;
}
