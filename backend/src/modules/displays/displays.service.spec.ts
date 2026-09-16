import {
  DisplaysService, DEFAULT_DISPLAY_CONFIG, generateDisplayToken, normalizeDisplayConfig, snapshotFingerprint,
  displayPushFingerprint, displayActionAvailability, filterSnapshotByConfig, stationGuidance, DISPLAY_OFFLINE_AFTER_MS,
  DISPLAY_ACTION_RATE,
} from './displays.service';

describe('Station Display Mode (owner order 2026-09-16)', () => {
  const makePrisma = () => ({
    station: {
      findUnique: jest.fn(),
    },
    stationDisplay: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    receivingSession: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    receivingScanEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { quantity: 0 } }),
    },
    receivingCarton: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    receivingDiscrepancy: { findFirst: jest.fn().mockResolvedValue(null) },
    receivingProduct: { findMany: jest.fn().mockResolvedValue([]) },
    temporaryStorageItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    expectedArrival: { findUnique: jest.fn().mockResolvedValue(null) },
    ayroviUnit: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    batchItem: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    batch: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    productStationMove: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    workerTaskAssignment: { findFirst: jest.fn() },
    // --- DISPLAY v2 (stage 2) -------------------------------------------
    stationDisplayAction: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    stationDisplayMessage: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), update: jest.fn() },
    stationPrintJob: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    operationalException: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  });
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
  const push = { notifyUsers: jest.fn().mockResolvedValue(0) };
  const actor = 'admin-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tokens are 64-hex and unique per call', () => {
    const a = generateDisplayToken();
    const b = generateDisplayToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toEqual(b);
  });

  it('normalizeDisplayConfig fills defaults, keeps only known keys, coerces booleans', () => {
    expect(normalizeDisplayConfig(undefined)).toEqual(expect.objectContaining(DEFAULT_DISPLAY_CONFIG));
    expect(normalizeDisplayConfig('junk')).toEqual(expect.objectContaining(DEFAULT_DISPLAY_CONFIG));
    const cfg = normalizeDisplayConfig({ worker: false, product: true, customer: 'yes', hack: true, reports: true } as any);
    expect(cfg.worker).toBe(false);
    expect(cfg.product).toBe(true); // strict booleans from the admin UI
    expect(cfg.customer).toBe(false); // non-true → false (strict === true)
    expect(cfg.reports).toBe(true);
    expect((cfg as any).hack).toBeUndefined(); // unknown key dropped
  });

  it('stage-2 config: a display is PASSIVE by default (interactive off) and stays passive with no allowed action', () => {
    const cfg = normalizeDisplayConfig(undefined);
    expect(cfg.interactive).toBe(false); // owner decision: opt-in per display
    expect(cfg.sound).toBe(true);
    expect(cfg.printTransport).toBe('BROWSER');
    // Owner order (2026-09-16): the first batch is PRINTING — a fresh
    // interactive display offers print/reprint (+ message seen) only, the
    // assist actions are opted in per display.
    expect(cfg.actions).toEqual({ print: true, reprint: true, ack: false, help: false, exception: false, message: true, move: false });
    expect(displayActionAvailability(cfg)).toEqual([]); // not interactive → nothing allowed

    const on = normalizeDisplayConfig({ interactive: true, actions: { print: true, help: true, exception: false, ack: false, reprint: false, message: false } });
    expect(displayActionAvailability(on)).toEqual(['print', 'help']);

    // Just switching a display ON (no action list) yields exactly the owner's
    // first batch: PRINT + REPRINT, plus the message confirmation.
    const fresh = normalizeDisplayConfig({ interactive: true });
    expect(displayActionAvailability(fresh)).toEqual(['print', 'reprint', 'message']);
    // an EMPTY actions object means "defaults", never "everything off"
    expect(normalizeDisplayConfig({ interactive: true, actions: {} }).interactive).toBe(true);
    // ...but explicitly switching every action off would render dead buttons → downgraded
    const allOff = normalizeDisplayConfig({ interactive: true, actions: { print: false, reprint: false, ack: false, help: false, exception: false, message: false } });
    expect(allOff.interactive).toBe(false);
    expect(displayActionAvailability(allOff)).toEqual([]);
    // unknown transport falls back to the safe default
    expect(normalizeDisplayConfig({ printTransport: 'CARRIER_PIGEON' }).printTransport).toBe('BROWSER');
  });

  it('create stores a token + normalized config and audits DISPLAY_CREATED', async () => {
    const prisma = makePrisma();
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({ id: 'st1', name: 'Receiving' });
    (prisma.stationDisplay.create as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ id: 'd1', ...data }));
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const row = await svc.create('st1', { name: '  Wall A ', config: { worker: false } }, actor);
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Wall A');
    expect(row!.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.config).toEqual(expect.objectContaining({ ...DEFAULT_DISPLAY_CONFIG, worker: false }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_CREATED', actorUserId: actor, entityId: 'd1' }));
  });

  it('create returns null for an unknown station (no audit)', async () => {
    const prisma = makePrisma();
    (prisma.station.findUnique as jest.Mock).mockResolvedValue(null);
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    expect(await svc.create('nope', {}, actor)).toBeNull();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('enable/disable + station move write the right audit actions with previous/new values', async () => {
    const prisma = makePrisma();
    const before = { id: 'd1', stationId: 'st1', name: 'D', enabled: false, config: {} };
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(before);
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({ id: 'st2', name: 'Packing' });
    (prisma.stationDisplay.update as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ ...before, ...data }));
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    await svc.update('d1', { enabled: true, stationId: 'st2' }, actor);
    const actions = audit.log.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('DISPLAY_ENABLED');
    expect(actions).toContain('DISPLAY_STATION_CHANGED');
    const enableCall = audit.log.mock.calls.find((c) => c[0].action === 'DISPLAY_ENABLED')[0];
    expect(enableCall.metadata.previousValue).toBe(false);
    expect(enableCall.metadata.newValue).toBe(true);
  });

  it('regenerate replaces the token and audits DISPLAY_ACCESS_REGENERATED', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({ id: 'd1', stationId: 'st1', name: 'D', enabled: true });
    (prisma.stationDisplay.update as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ id: 'd1', ...data }));
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const row = await svc.regenerate('d1', actor);
    expect(row).not.toBeNull();
    expect(row!.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_ACCESS_REGENERATED' }));
  });

  it('delete audits DISPLAY_DELETED', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({ id: 'd1', stationId: 'st1', name: 'D' });
    (prisma.stationDisplay.delete as jest.Mock).mockResolvedValue({});
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    await svc.remove('d1', actor);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_DELETED' }));
  });

  it('snapshotForToken: unknown token → null; disabled display exposes NO station data', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1', enabled: false, name: 'D', displayType: 'LIVE_STATION', station: { name: 'X' } });
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    expect(await svc.snapshotForToken('missing')).toBeNull();
    const disabled = await svc.snapshotForToken('tok');
    expect(disabled).toEqual({ enabled: false, display: { name: 'D' } });
    // station data never queried for a disabled display
    expect(prisma.receivingSession.findFirst).not.toHaveBeenCalled();
  });

  it('snapshot maps real transaction ids (same TX on CT40 and display) and honors config filtering', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({
      id: 'd1', enabled: true, name: 'Wall', displayType: 'LIVE_STATION',
      station: { name: 'Receiving' },
      config: { worker: false, customer: false, quantity: false, status: false, progress: false },
    });
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({
      code: 'RECV-01', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE',
      assignedWorker: { id: 'u1', name: 'Sam', employeeCode: 'W024' },
    });
    (prisma.receivingSession.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: 's1', code: 'RCV-1', status: 'RECEIVING', arrival: { code: 'AR-1', customerName: 'Ahmed', customerSurname: 'S.' }, _count: { scanEvents: 3 } })
      .mockResolvedValueOnce(null); // fallback historical session (not needed, active exists)
    (prisma.temporaryStorageItem.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workerTaskAssignment.findFirst as jest.Mock).mockResolvedValue({ title: 'Verify product', status: 'ASSIGNED' });
    (prisma.receivingScanEvent.findFirst as jest.Mock).mockResolvedValue({ id: 'TX-123456', kind: 'PRODUCT', code: 'SA12345', quantity: 3, createdAt: new Date('2026-09-16T10:00:00Z') });
    (prisma.receivingCarton.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.receivingDiscrepancy.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.receivingProduct.findMany as jest.Mock).mockResolvedValue([
      { expectedQuantity: 50, receivedQuantity: 37 },
    ]);

    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const snap = (await svc.snapshotForToken('tok')) as any;

    expect(snap.enabled).toBe(true);
    expect(snap.lastScan.id).toBe('TX-123456'); // same transaction id, no -Display clone
    expect(snap.progress).toBeUndefined(); // progress=false in config
    expect(snap.worker).toBeUndefined(); // worker=false
    expect(snap.lastScan.customerName).toBeUndefined(); // customer=false
    expect(snap.lastScan.quantity).toBeUndefined(); // quantity=false
    expect(snap.task.title).toBe('Verify product');
  });

  it('filterSnapshotByConfig hides status errors and reports by default-off reports', () => {
    const raw = {
      station: { code: 'A' }, worker: { code: 'W024' }, operation: { label: 'RECEIVING' },
      task: { title: 'T' }, lastScan: { id: 'x', kind: 'PRODUCT', code: 'SA', productName: 'P', customerName: 'C', quantity: 2, status: 'CONFIRMED', at: 1 },
      error: { type: 'SHORTAGE' }, progress: { done: 1, total: 2 }, customer: 'C',
    };
    const out = filterSnapshotByConfig(raw, {}) as any;
    expect(out.station).toBeDefined();
    expect(out.lastScan.quantity).toBeDefined(); // defaults on
    expect(out.error).toEqual({ type: 'SHORTAGE' });
    expect(out.reports).toBeUndefined(); // hidden sections are omitted entirely
    const noStatus = filterSnapshotByConfig(raw, { status: false }) as any;
    expect(noStatus.error).toBeUndefined();
    expect(noStatus.lastScan.status).toBeUndefined();
  });

  it('BATCH station: worker-bound batch activity reaches the display (owner report 2026-09-16)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({
      id: 'd1', enabled: true, name: 'Batch Wall', displayType: 'LIVE_STATION',
      station: { name: 'BATCH-01' }, config: {},
    });
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({
      code: 'BATCH-01', name: 'BATCH-01', department: 'BATCH', status: 'ACTIVE',
      assignedWorkerId: 'u6',
      assignedWorker: { id: 'u6', name: 'TEST BATCH WORKER', employeeCode: 'WORKER006' },
    });
    // no receiving session / no TS item — only batch writes exist
    (prisma.receivingSession.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.temporaryStorageItem.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workerTaskAssignment.findFirst as jest.Mock).mockResolvedValue(null);
    // worker scanned 3 units in build, then received one (same worker)
    (prisma.ayroviUnit.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1', code: 'AYP-000003', originalBarcode: 'SA12345', originalSku: null, originalReference: null,
      createdAt: new Date('2026-09-16T09:58:00Z'),
    });
    (prisma.batchItem.findFirst as jest.Mock).mockResolvedValue({
      id: 'bi2', status: 'RECEIVED',
      unit: { code: 'AYP-000001', originalBarcode: 'SA99999', originalSku: null, originalReference: null },
      batch: { batchCode: 'AYB-260916-01', status: 'RECEIVING_IN_PROGRESS', totalScanned: 2, totalExpected: 3, updatedAt: new Date('2026-09-16T10:02:00Z') },
    });
    (prisma.batch.findFirst as jest.Mock).mockResolvedValue({
      id: 'b1', batchCode: 'AYB-260916-01', status: 'RECEIVING_IN_PROGRESS',
      totalScanned: 2, totalExpected: 3, updatedAt: new Date('2026-09-16T10:02:00Z'),
    });

    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const snap = (await svc.snapshotForToken('tok')) as any;

    expect(snap.operation).toMatchObject({ label: 'BATCH RECEIVING', sessionCode: 'AYB-260916-01' });
    expect(snap.progress).toEqual({ done: 2, total: 3, label: 'units' });
    // newest activity wins: batch receive (10:02) beats build unit (09:58)
    expect(snap.lastScan).toMatchObject({ kind: 'BATCH RECEIVE', code: 'SA99999', status: 'RECEIVED' });
  });

  it('BATCH BUILD shows units-so-far and no progress bar (no target yet)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({
      id: 'd1', enabled: true, name: 'B', displayType: 'LIVE_STATION', station: { name: 'BATCH-01' }, config: {},
    });
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({
      code: 'BATCH-01', name: 'BATCH-01', department: 'BATCH', status: 'ACTIVE',
      assignedWorkerId: 'u6',
      assignedWorker: { id: 'u6', name: 'W', employeeCode: 'WORKER006' },
    });
    (prisma.receivingSession.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.temporaryStorageItem.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workerTaskAssignment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.ayroviUnit.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1', code: 'AYP-000002', originalBarcode: null, originalSku: 'SKU-9', originalReference: null,
      createdAt: new Date(),
    });
    (prisma.batchItem.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.batch.findFirst as jest.Mock).mockResolvedValue({
      id: 'b1', batchCode: 'AYB-2', status: 'CREATED', totalScanned: 0, totalExpected: 5, updatedAt: new Date(),
    });

    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const snap = (await svc.snapshotForToken('tok')) as any;
    expect(snap.operation).toMatchObject({ label: 'BATCH BUILD', sessionCode: 'AYB-2' });
    expect(snap.progress).toBeNull();
    expect(snap.lastScan).toMatchObject({ kind: 'BATCH UNIT', code: 'SKU-9' });
  });

  it('recent feed: ALL station actions merged newest-first (receiving + batch + storage) and capped at 10', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({
      id: 'd1', enabled: true, name: 'R', displayType: 'LIVE_STATION', station: { name: 'RECV-1' }, config: {},
    });
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({
      code: 'RECV-1', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE',
      assignedWorkerId: 'u6', assignedWorker: { id: 'u6', name: 'W', employeeCode: 'WORKER006' },
    });
    (prisma.receivingSession.findMany as jest.Mock).mockResolvedValue([{ id: 's1' }]);
    (prisma.receivingScanEvent.findMany as jest.Mock).mockResolvedValue([
      { id: 'rx1', kind: 'PRODUCT', code: 'SA1', quantity: 2, createdAt: new Date('2026-09-16T10:00:00Z') },
    ]);
    (prisma.receivingCarton.findMany as jest.Mock).mockResolvedValue([
      { id: 'c1', scannedCode: 'CTN-9', status: 'RECEIVED', receivedAt: new Date('2026-09-16T09:00:00Z'), createdAt: new Date('2026-09-16T09:00:00Z') },
    ]);
    (prisma.ayroviUnit.findMany as jest.Mock).mockResolvedValue([
      { id: 'u1', code: 'AYP-2', originalBarcode: 'SA2', originalSku: null, originalReference: null, createdAt: new Date('2026-09-16T10:05:00Z') },
    ]);
    (prisma.batchItem.findMany as jest.Mock).mockResolvedValue([
      { id: 'bi1', receivedAt: new Date('2026-09-16T10:10:00Z'), unit: { code: 'AYP-1', originalBarcode: 'SA0', originalSku: null, originalReference: null } },
    ]);
    (prisma.temporaryStorageItem.findMany as jest.Mock).mockResolvedValue([
      { id: 't1', sku: 'SA3', reference: null, productName: 'Chair', customerName: 'Ahmed', quantity: 3, status: 'STORED', createdAt: new Date('2026-09-16T08:00:00Z') },
    ]);
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const snap = (await svc.snapshotForToken('tok')) as any;
    const kinds = snap.recent.map((r: any) => r.kind);
    expect(kinds).toEqual(['BATCH RECEIVE', 'BATCH UNIT', 'SCAN', 'CARTON', 'STORAGE']); // newest first
    expect(snap.recent).toHaveLength(5);
    expect(snap.recent[0]).toMatchObject({ code: 'SA0', status: 'RECEIVED' });
    expect(snap.recent[4]).toMatchObject({ kind: 'STORAGE', customerName: 'Ahmed', quantity: 3 });
  });

  it('feed includes TRANSFERS (IN/OUT) and batch lifecycle (SENT/DONE) — the display shows all actions', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({
      id: 'd1', enabled: true, name: 'R', displayType: 'LIVE_STATION', stationId: 'st', station: { name: 'RECV-1' }, config: {},
    });
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({
      code: 'RECV-1', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE',
      assignedWorkerId: 'u6', assignedWorker: { id: 'u6', name: 'W', employeeCode: 'W6' },
    });
    (prisma.receivingSession.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.temporaryStorageItem.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.productStationMove.findMany as jest.Mock).mockResolvedValue([
      { id: 'm1', fromStationId: 'st', toStationId: null, sku: 'SA-OUT', reference: null, productName: null, confirmedQuantity: 4, result: 'CONFIRMED', createdAt: new Date('2026-09-16T11:00:00Z') },
      { id: 'm2', fromStationId: null, toStationId: 'st', sku: null, reference: 'REF-IN', productName: 'Desk', confirmedQuantity: 2, result: 'CONFIRMED', createdAt: new Date('2026-09-16T11:05:00Z') },
    ]);
    (prisma.batch.findMany as jest.Mock).mockResolvedValue([
      { id: 'b9', batchCode: 'AYB-9', status: 'SENT_TO_RECEIVING', totalExpected: 7, totalScanned: 0, updatedAt: new Date('2026-09-16T10:30:00Z') },
    ]);
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const snap = (await svc.snapshotForToken('tok')) as any;
    const kinds = snap.recent.map((r: any) => `${r.kind}:${r.code}`);
    // newest first: IN 11:05 > OUT 11:00 > BATCH SENT 10:30
    expect(kinds).toEqual(['IN:REF-IN', 'OUT:SA-OUT', 'BATCH SENT:AYB-9']);
    expect(snap.recent[0]).toMatchObject({ kind: 'IN', productName: 'Desk', quantity: 2 });
    expect(snap.recent[1]).toMatchObject({ kind: 'OUT', quantity: 4 });
    expect(snap.recent[2]).toMatchObject({ kind: 'BATCH SENT', quantity: 7 });
  });

  it('recent:false in the display config removes the feed entirely (server-side)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({
      id: 'd1', enabled: true, name: 'R', displayType: 'LIVE_STATION', station: { name: 'RECV-1' },
      config: { recent: false },
    });
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({
      code: 'RECV-1', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE', assignedWorkerId: null, assignedWorker: null,
    });
    (prisma.receivingSession.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.temporaryStorageItem.findMany as jest.Mock).mockResolvedValue([]);
    const svc = new DisplaysService(prisma as any, audit as any, events as any, push as any);
    const snap = (await svc.snapshotForToken('tok')) as any;
    expect(snap.recent).toBeUndefined();
  });

  it('fingerprint changes only when the snapshot content changes', () => {
    const a = { x: 1 };
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint({ x: 1 }));
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint({ x: 2 }));
  });

  it('offline threshold is bounded (90s) so stale screens show Offline', () => {
    expect(DISPLAY_OFFLINE_AFTER_MS).toBe(90_000);
  });

  it('push fingerprint ignores lastUpdate (idle screens are not re-pushed) but follows real content', () => {
    const a = { station: { code: 'A' }, lastUpdate: '2026-09-16T10:00:00Z' };
    const b = { station: { code: 'A' }, lastUpdate: '2026-09-16T10:00:03Z' };
    expect(displayPushFingerprint(a)).toBe(displayPushFingerprint(b));
    expect(displayPushFingerprint(a)).not.toBe(displayPushFingerprint({ ...b, station: { code: 'B' } }));
  });
});

/**
 * STAGE 2 — INTERACTIVE DISPLAYS (owner order 2026-09-16).
 * «the display must help the worker, show and record every action, and let us
 * act from it — print or other actions — for all stations».
 */
describe('Station Display v2 — actions from the screen', () => {
  const makePrisma = () => ({
    station: {
      findUnique: jest.fn().mockResolvedValue({ id: 'st1', code: 'RECV-01', name: 'Receiving', assignedWorkerId: null, assignedWorker: null, department: 'RECEIVING', status: 'ACTIVE' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    stationDisplay: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    stationDisplayAction: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'act1', createdAt: new Date(), ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    stationDisplayMessage: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'msg1', createdAt: new Date(), acknowledgedAt: null, ...data })),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'msg1', acknowledgedAt: data.acknowledgedAt })),
    },
    stationPrintJob: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'job1', status: 'QUEUED', ...data })),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'job1', target: 'SCAN', targetRef: 'SA1', transport: 'BROWSER', ...data })),
    },
    operationalException: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'exc1', ...data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin1' }]) },
    receivingSession: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    receivingScanEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { quantity: 0 } }),
    },
    receivingCarton: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    receivingDiscrepancy: { findFirst: jest.fn().mockResolvedValue(null) },
    receivingProduct: { findMany: jest.fn().mockResolvedValue([]) },
    temporaryStorageItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    expectedArrival: { findUnique: jest.fn().mockResolvedValue(null) },
    ayroviUnit: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    batchItem: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    batch: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    productStationMove: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    workerTaskAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
  });
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn(), on: jest.fn(), off: jest.fn() };
  const push = { notifyUsers: jest.fn().mockResolvedValue(3) };

  const displayRow = (config: Record<string, unknown>, enabled = true) => ({
    id: 'd1', name: 'Wall A', enabled, displayType: 'LIVE_STATION', stationId: 'st1',
    station: { id: 'st1', code: 'RECV-01', name: 'Receiving' }, config,
  });
  const interactive = { interactive: true, actions: { print: true, reprint: true, ack: true, help: true, exception: true, message: true } };

  /** Wire $transaction to run the callback against the same mock client. */
  const svcFor = (prisma: any) => {
    prisma.$transaction = jest.fn((fn: any) => fn(prisma));
    return new DisplaysService(prisma, audit as any, events as any, push as any);
  };

  beforeEach(() => jest.clearAllMocks());

  it('a NON-interactive display refuses every action (read-only stays read-only)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow({}));
    const svc = svcFor(prisma);
    await expect(svc.acknowledge('tok', {})).rejects.toMatchObject({ status: 403 });
    await expect(svc.printLabel('tok', {})).rejects.toMatchObject({ status: 403 });
    expect(audit.log).not.toHaveBeenCalled();
    expect(prisma.stationPrintJob.create).not.toHaveBeenCalled();
  });

  it('interactive display: ACK records the action, audits DISPLAY_ACTION_ACK and pings the screens', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    const res = await svc.acknowledge('tok', { note: 'seen by Amina' });
    expect(res.ok).toBe(true);
    expect(prisma.stationDisplayAction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'ACK', stationId: 'st1', summary: expect.stringContaining('Amina') }),
    }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_ACTION_ACK', entityId: 'd1' }));
    expect(events.emit).toHaveBeenCalledWith('station.activity', expect.objectContaining({ kind: 'ACK' }));
  });

  it('a single action switch can be turned off without disabling the screen', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(
      displayRow({ interactive: true, actions: { ack: true, print: false, help: false, exception: false, reprint: false, message: false } }),
    );
    const svc = svcFor(prisma);
    await expect(svc.printLabel('tok', {})).rejects.toMatchObject({ status: 403 });
    await expect(svc.acknowledge('tok', {})).resolves.toMatchObject({ ok: true });
  });

  it('HELP: audits, records the action and pushes the supervisors', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    const res = await svc.requestHelp('tok', { note: 'carton blocked', urgent: true });
    expect(res).toMatchObject({ ok: true, notified: 3 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_HELP_REQUESTED' }));
    expect(push.notifyUsers).toHaveBeenCalledWith(['admin1'], expect.objectContaining({ route: '/admin/displays' }));
  });

  it('EXCEPTION: a REAL OperationalException row (same board, same code family) + audit', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    const res = await svc.raiseException('tok', { type: 'DAMAGED', reason: 'pallet damaged at dock', code: 'SA123' });
    expect(res.ok).toBe(true);
    expect(res.exceptionCode).toMatch(/^EXC-/);
    expect(prisma.operationalException.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stationId: 'st1', type: 'DAMAGED', entityCode: 'SA123', reportedById: null }),
    }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_EXCEPTION_RAISED' }));
  });

  it('EXCEPTION without a reason is refused (no silent empty exception)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    await expect(svc.raiseException('tok', {})).rejects.toMatchObject({ status: 400 });
    expect(prisma.operationalException.create).not.toHaveBeenCalled();
  });

  it('PRINT: queues a job with the SAME last-scan identity the operator sees, then reports the result', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    (prisma.receivingSession.findFirst as jest.Mock).mockResolvedValue({ id: 's1', code: 'RCV-77', status: 'RECEIVING', stationId: 'st1', _count: { scanEvents: 4 } });
    (prisma.receivingScanEvent.findFirst as jest.Mock).mockResolvedValue({ id: 'TX-77', kind: 'PRODUCT', code: 'SA-77', quantity: 2, createdAt: new Date() });
    const svc = svcFor(prisma);
    const res = await svc.printLabel('tok', {});
    expect(res.job).toMatchObject({ id: 'job1', target: 'SCAN', targetRef: 'SA-77', transport: 'BROWSER' });
    expect(prisma.stationPrintJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stationId: 'st1', displayId: 'd1', status: 'QUEUED', payload: expect.objectContaining({ code: 'SA-77', reference: 'TX-77' }) }),
    }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_PRINT_REQUESTED' }));

    (prisma.stationPrintJob.findUnique as jest.Mock).mockResolvedValue({ id: 'job1', stationId: 'st1', target: 'SCAN', targetRef: 'SA-77', transport: 'BROWSER' });
    const done = await svc.printResult('tok', 'job1', { status: 'PRINTED' });
    expect(done.job.status).toBe('PRINTED');
    expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'DISPLAY_PRINT_COMPLETED' }));
  });

  it('PRINT with nothing on screen is refused (never print a blank label)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    await expect(svc.printLabel('tok', {})).rejects.toMatchObject({ status: 400 });
  });

  it('REPRINT reuses the ORIGINAL payload and points at the original job', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    (prisma.stationPrintJob.findUnique as jest.Mock).mockResolvedValue({
      id: 'job0', stationId: 'st1', target: 'CARTON', targetRef: 'CTN-1', payload: { code: 'CTN-1' }, transport: 'BROWSER',
    });
    const svc = svcFor(prisma);
    const res = await svc.printLabel('tok', { reprintOf: 'job0' });
    expect(res.job).toMatchObject({ target: 'CARTON', targetRef: 'CTN-1' });
    expect(prisma.stationPrintJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reprintOf: 'job0', payload: { code: 'CTN-1' } }),
    }));
  });

  it('a print job of ANOTHER station can not be reprinted or resolved from this screen', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    (prisma.stationPrintJob.findUnique as jest.Mock).mockResolvedValue({ id: 'jobX', stationId: 'OTHER', target: 'SCAN', payload: {} });
    const svc = svcFor(prisma);
    await expect(svc.printLabel('tok', { reprintOf: 'jobX' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.printResult('tok', 'jobX', { status: 'PRINTED' })).rejects.toMatchObject({ status: 404 });
  });

  it('operator MESSAGE: admin sends, screen acknowledges — both audited, both in the station feed', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    const sent = await svc.sendMessage('d1', { body: 'Come to gate 2', severity: 'URGENT' }, 'admin1');
    expect(sent).toMatchObject({ message: expect.objectContaining({ body: 'Come to gate 2', severity: 'URGENT' }) });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_MESSAGE_SENT', actorUserId: 'admin1' }));

    (prisma.stationDisplayMessage.findUnique as jest.Mock).mockResolvedValue({ id: 'msg1', displayId: 'd1', severity: 'URGENT', acknowledgedAt: null });
    const ack = await svc.acknowledgeMessage('tok', 'msg1', { note: 'on my way' });
    expect(ack.ok).toBe(true);
    expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'DISPLAY_MESSAGE_ACK' }));
    expect(prisma.stationDisplayAction.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'MESSAGE_SEEN' }),
    }));
  });

  it('rate limit: a screen can not hammer the API (bounded actions per window)', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow(interactive));
    const svc = svcFor(prisma);
    for (let i = 0; i < DISPLAY_ACTION_RATE.max; i += 1) await svc.acknowledge('tok-rate', {});
    await expect(svc.acknowledge('tok-rate', {})).rejects.toMatchObject({ status: 429 });
  });

  it('an UNKNOWN token can not act at all', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(null);
    const svc = svcFor(prisma);
    await expect(svc.acknowledge('nope', {})).rejects.toMatchObject({ status: 404 });
  });

  it('snapshot exposes what the screen may DO + pending operator messages', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow({ ...interactive, sound: false }));
    (prisma.stationDisplayMessage.findMany as jest.Mock).mockResolvedValue([
      { id: 'm1', body: 'Stop scanning', severity: 'URGENT', requireAck: true, createdAt: new Date() },
    ]);
    const svc = svcFor(prisma);
    const snap = (await svc.snapshotForToken('tok')) as any;
    expect(snap.options).toEqual({ interactive: true, sound: false, printTransport: 'BROWSER', actions: ['print', 'reprint', 'ack', 'help', 'exception', 'message'] });
    expect(snap.messages).toHaveLength(1);
    expect(snap.messages[0]).toMatchObject({ body: 'Stop scanning', severity: 'URGENT' });
  });

  it('FLEET: every station is listed — including the ones with NO display', async () => {
    const prisma = makePrisma();
    (prisma.station.findMany as jest.Mock).mockResolvedValue([
      { id: 'st1', code: 'RECV-01', name: 'Receiving', department: 'RECEIVING', status: 'ACTIVE', zone: { code: 'Z1' }, assignedWorker: null,
        displays: [{ id: 'd1', name: 'Wall A', enabled: true, displayType: 'LIVE_STATION', lastSeenAt: new Date(), createdAt: new Date(), config: { interactive: true } }] },
      { id: 'st2', code: 'BATCH-01', name: 'Batch', department: 'BATCH', status: 'ACTIVE', zone: null, assignedWorker: null, displays: [] },
    ]);
    const svc = svcFor(prisma);
    const fleet = await svc.fleet();
    expect(fleet.counters).toMatchObject({ stations: 2, stationsWithDisplay: 1, stationsWithoutDisplay: 1, displays: 1, interactive: 1 });
    expect(fleet.stations[1].displays).toEqual([]);
    expect(fleet.stations[0].displays[0]).toMatchObject({ online: true, interactive: true });
    // tokens must never be part of the fleet payload
    expect(JSON.stringify(fleet)).not.toContain('accessToken');
  });

  it('FLEET bulk CREATE_MISSING: one display per ACTIVE station that has none, audited once', async () => {
    const prisma = makePrisma();
    (prisma.station.findMany as jest.Mock).mockResolvedValue([
      { id: 'st1', code: 'RECV-01', name: 'Receiving' },
      { id: 'st2', code: 'PACK-01', name: 'Packing' },
    ]);
    (prisma.stationDisplay.create as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ id: `d-${data.stationId}`, ...data }));
    const svc = svcFor(prisma);
    const res = await svc.bulk({ action: 'CREATE_MISSING' }, 'admin1');


    expect(res.applied).toBe(2);
    expect(res.created.map((c: any) => c.urlPath)).toEqual([expect.stringMatching(/^\/display\/[0-9a-f]{64}$/), expect.stringMatching(/^\/display\/[0-9a-f]{64}$/)]);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_BULK_CREATED', metadata: expect.objectContaining({ count: 2 }) }));
  });
  // ------------------------------------------------------------------
  // ASSIST LAYER (owner order 2026-09-16: «every screen shows everything
  // about the station and HELPS the worker»). The next action is server-side
  // truth: it is computed from the same rows the terminal writes, so the
  // screen can never invent a step.
  // ------------------------------------------------------------------
  describe('station guidance (what to do NOW)', () => {
    const base = {
      stationStatus: 'ACTIVE',
      department: 'RECEIVING',
      receiving: null,
      batch: null,
      task: null,
      storage: null,
    } as any;

    it('a station that is not ACTIVE tells the operator to ask a supervisor', () => {
      const g = stationGuidance({ ...base, stationStatus: 'MAINTENANCE' });
      expect(g.guidance).toMatchObject({ code: 'STATION_INACTIVE', tone: 'WAIT' });
      expect(g.guidance?.detail).toContain('MAINTENANCE');
      expect(g.waiting).not.toBeNull();
    });

    it('receiving with units left: SCAN_PRODUCT + the expected queue, biggest gap first', () => {
      const g = stationGuidance({
        ...base,
        receiving: {
          active: true,
          sessionCode: 'RCV-1',
          startedAt: new Date('2026-09-16T08:00:00Z'),
          hasDiscrepancy: false,
          products: [
            { code: 'SA-1', productName: 'Chair', expected: 50, received: 40 },
            { code: 'SA-2', productName: 'Lamp', expected: 12, received: 0 },
            { code: 'SA-3', productName: 'Done', expected: 5, received: 5 },
          ],
        },
      });
      expect(g.guidance).toMatchObject({ code: 'SCAN_PRODUCT', tone: 'SCAN', instruction: 'Scan the next product' });
      expect(g.guidance?.detail).toContain('SA-2'); // the biggest gap is the next step
      expect(g.queue.map((q) => q.code)).toEqual(['SA-2', 'SA-1']); // SA-3 is complete → not in the queue
      expect(g.queue[0]).toMatchObject({ remaining: 12, expected: 12 });
      expect(g.waiting).toBeNull();
    });

    it('receiving complete: close the session — unless a discrepancy is still open', () => {
      const done = {
        active: true, sessionCode: 'RCV-1', startedAt: null, hasDiscrepancy: false,
        products: [{ code: 'SA-1', productName: null, expected: 5, received: 5 }],
      };
      expect(stationGuidance({ ...base, receiving: done }).guidance).toMatchObject({ code: 'CLOSE_SESSION', tone: 'DONE' });
      expect(stationGuidance({ ...base, receiving: { ...done, hasDiscrepancy: true } }).guidance).toMatchObject({
        code: 'RESOLVE_DISCREPANCY', tone: 'ALERT',
      });
    });

    it('a session with no product line yet: start scanning', () => {
      const g = stationGuidance({
        ...base,
        receiving: { active: true, sessionCode: 'RCV-1', startedAt: null, hasDiscrepancy: false, products: [] },
      });
      expect(g.guidance).toMatchObject({ code: 'SCAN_FIRST', tone: 'SCAN' });
    });

    it('batch build vs batch receiving drive the same band', () => {
      const build = stationGuidance({
        ...base, department: 'BATCH',
        batch: { code: 'B-1', status: 'CREATED', totalExpected: 12, totalScanned: 3 },
      });
      expect(build.guidance).toMatchObject({ code: 'BUILD_UNIT', tone: 'SCAN' });
      expect(build.queue[0]).toMatchObject({ code: 'B-1', remaining: 9, expected: 12 });

      const receive = stationGuidance({
        ...base, department: 'BATCH',
        batch: { code: 'B-1', status: 'RECEIVING_IN_PROGRESS', totalExpected: 12, totalScanned: 12 },
      });
      expect(receive.guidance).toMatchObject({ code: 'BATCH_DONE', tone: 'DONE' });
    });

    it('temporary storage: store the next product — and shout when one needs review', () => {
      const store = stationGuidance({
        ...base, department: 'STAGING',
        storage: { code: 'SA-9', section: 'B', status: 'STORED', needsReview: false },
      });
      expect(store.guidance).toMatchObject({ code: 'STORE_PRODUCT', tone: 'SCAN' });
      expect(store.guidance?.detail).toContain('section B');

      const review = stationGuidance({
        ...base, department: 'STAGING',
        storage: { code: 'SA-9', section: 'B', status: 'REVIEW', needsReview: true },
      });
      expect(review.guidance).toMatchObject({ code: 'STORAGE_REVIEW', tone: 'ALERT' });
    });

    it('an open task is the instruction; with nothing open the screen says so', () => {
      const task = stationGuidance({ ...base, task: { title: 'Count the pallet', status: 'ASSIGNED' } });
      expect(task.guidance).toMatchObject({ code: 'TASK', instruction: 'Count the pallet' });

      const idle = stationGuidance(base);
      expect(idle.guidance).toMatchObject({ code: 'WAITING', tone: 'WAIT' });
      expect(idle.waiting?.reason).toContain('Waiting');
    });
  });

  it('assist sections obey the SAME visibility switches (a hidden section never leaves the API)', () => {
    const raw = {
      station: { code: 'RECV-01' },
      guidance: { code: 'SCAN_PRODUCT', instruction: 'Scan the next product', detail: 'SA-2', tone: 'SCAN' },
      waiting: null,
      queue: [{ code: 'SA-2', productName: null, remaining: 10, expected: 10, hint: '10 of 10 units left' }],
      alerts: [{ id: 'a1', kind: 'EXCEPTION', code: 'EXC-1', reason: 'blocked', at: new Date(), severity: 'HIGH' }],
      stats: { scans: 12, units: 24, cartons: 2, stored: 3, transfersOut: 1, actions: 4, since: new Date().toISOString() },
      help: { open: true, at: new Date() },
      recent: [],
      customer: null,
    };
    const on = filterSnapshotByConfig(raw, {
      guidance: true, queue: true, alerts: true, stats: true, station: true,
    }) as any;
    expect(on.guidance.code).toBe('SCAN_PRODUCT');
    expect(on.queue).toHaveLength(1);
    expect(on.alerts[0].code).toBe('EXC-1');
    expect(on.stats.scans).toBe(12);
    expect(on.help.open).toBe(true);

    const off = filterSnapshotByConfig(raw, {
      guidance: false, queue: false, alerts: false, stats: false, station: true,
    }) as any;
    expect(off.guidance).toBeUndefined();
    expect(off.waiting).toBeUndefined();
    expect(off.queue).toBeUndefined();
    expect(off.alerts).toBeUndefined();
    expect(off.help).toBeUndefined();
    expect(off.stats).toBeUndefined();
    // and nothing leaked under another name
    expect(JSON.stringify(off)).not.toContain('SCAN_PRODUCT');
  });

  it('a live receiving station gets guidance + queue + today stats in the snapshot', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow({}));
    const session = {
      id: 's1', code: 'RCV-000301', status: 'RECEIVING', stationId: 'st1', arrivalId: 'a1',
      startedAt: new Date('2026-09-16T08:00:00Z'), _count: { scanEvents: 4 },
    };
    (prisma.receivingSession.findFirst as jest.Mock).mockResolvedValue(session);
    // today's sessions at the station — the shift totals are counted over them
    (prisma.receivingSession.findMany as jest.Mock).mockResolvedValue([{ id: 's1' }]);
    (prisma.receivingProduct.findMany as jest.Mock).mockResolvedValue([
      { sku: 'SA-4471', reference: null, productName: 'Chair', expectedQuantity: 50, receivedQuantity: 37, status: 'PARTIALLY_RECEIVED' },
    ]);
    (prisma.receivingScanEvent.aggregate as jest.Mock).mockResolvedValue({ _count: { _all: 9 }, _sum: { quantity: 21 } });
    (prisma.receivingCarton.count as jest.Mock).mockResolvedValue(3);
    (prisma.temporaryStorageItem.count as jest.Mock).mockResolvedValue(2);
    (prisma.productStationMove.count as jest.Mock).mockResolvedValue(1);
    (prisma.stationDisplayAction.count as jest.Mock).mockResolvedValue(5);

    const svc = svcFor(prisma);
    const snap = (await svc.snapshotForToken('tok')) as any;

    expect(snap.guidance).toMatchObject({ code: 'SCAN_PRODUCT', tone: 'SCAN' });
    expect(snap.queue[0]).toMatchObject({ code: 'SA-4471', remaining: 13, expected: 50 });
    expect(snap.stats).toMatchObject({ scans: 9, units: 21, cartons: 3, stored: 2, transfersOut: 1, actions: 5 });
    expect(snap.alerts).toEqual([]);
    expect(snap.help).toMatchObject({ open: false });
    expect(snap.operation.startedAt).toEqual(session.startedAt);
  });

  it('an open exception and an unanswered HELP both land in the alerts strip', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(displayRow({}));
    (prisma.operationalException.findMany as jest.Mock).mockResolvedValue([
      { id: 'e1', code: 'EXC-000042', type: 'DAMAGED', reason: 'DISPLAY Wall A: pallet damaged', createdAt: new Date() },
    ]);
    (prisma.stationDisplayAction.findFirst as jest.Mock)
      .mockImplementation(({ where }: any) =>
        Promise.resolve(where.kind === 'HELP' ? { createdAt: new Date(), metadata: { urgent: true } } : null));
    const svc = svcFor(prisma);
    const snap = (await svc.snapshotForToken('tok')) as any;
    expect(snap.alerts.map((a: any) => a.kind)).toEqual(['EXCEPTION', 'HELP']);
    expect(snap.alerts[1]).toMatchObject({ severity: 'HIGH' }); // urgent call
    expect(snap.help.open).toBe(true);
  });
});
