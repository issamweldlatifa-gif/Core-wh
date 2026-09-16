import { DisplaysService, DEFAULT_DISPLAY_CONFIG, generateDisplayToken, normalizeDisplayConfig, snapshotFingerprint, filterSnapshotByConfig, DISPLAY_OFFLINE_AFTER_MS } from './displays.service';

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
    receivingSession: { findFirst: jest.fn() },
    receivingScanEvent: { findFirst: jest.fn() },
    receivingCarton: { findFirst: jest.fn() },
    receivingDiscrepancy: { findFirst: jest.fn() },
    receivingProduct: { findMany: jest.fn() },
    temporaryStorageItem: { findFirst: jest.fn() },
    expectedArrival: { findUnique: jest.fn().mockResolvedValue(null) },
    ayroviUnit: { findFirst: jest.fn().mockResolvedValue(null) },
    batchItem: { findFirst: jest.fn().mockResolvedValue(null) },
    batch: { findFirst: jest.fn().mockResolvedValue(null) },
    workerTaskAssignment: { findFirst: jest.fn() },
  });
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
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
    expect(normalizeDisplayConfig(undefined)).toEqual(DEFAULT_DISPLAY_CONFIG);
    expect(normalizeDisplayConfig('junk')).toEqual(DEFAULT_DISPLAY_CONFIG);
    const cfg = normalizeDisplayConfig({ worker: false, product: true, customer: 'yes', hack: true, reports: true } as any);
    expect(cfg.worker).toBe(false);
    expect(cfg.product).toBe(true); // strict booleans from the admin UI
    expect(cfg.customer).toBe(false); // non-true → false (strict === true)
    expect(cfg.reports).toBe(true);
    expect((cfg as any).hack).toBeUndefined(); // unknown key dropped
  });

  it('create stores a token + normalized config and audits DISPLAY_CREATED', async () => {
    const prisma = makePrisma();
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({ id: 'st1', name: 'Receiving' });
    (prisma.stationDisplay.create as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ id: 'd1', ...data }));
    const svc = new DisplaysService(prisma as any, audit as any);
    const row = await svc.create('st1', { name: '  Wall A ', config: { worker: false } }, actor);
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Wall A');
    expect(row!.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.config).toEqual({ ...DEFAULT_DISPLAY_CONFIG, worker: false });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_CREATED', actorUserId: actor, entityId: 'd1' }));
  });

  it('create returns null for an unknown station (no audit)', async () => {
    const prisma = makePrisma();
    (prisma.station.findUnique as jest.Mock).mockResolvedValue(null);
    const svc = new DisplaysService(prisma as any, audit as any);
    expect(await svc.create('nope', {}, actor)).toBeNull();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('enable/disable + station move write the right audit actions with previous/new values', async () => {
    const prisma = makePrisma();
    const before = { id: 'd1', stationId: 'st1', name: 'D', enabled: false, config: {} };
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue(before);
    (prisma.station.findUnique as jest.Mock).mockResolvedValue({ id: 'st2', name: 'Packing' });
    (prisma.stationDisplay.update as jest.Mock).mockImplementation(({ data }) => Promise.resolve({ ...before, ...data }));
    const svc = new DisplaysService(prisma as any, audit as any);
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
    const svc = new DisplaysService(prisma as any, audit as any);
    const row = await svc.regenerate('d1', actor);
    expect(row).not.toBeNull();
    expect(row!.accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_ACCESS_REGENERATED' }));
  });

  it('delete audits DISPLAY_DELETED', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock).mockResolvedValue({ id: 'd1', stationId: 'st1', name: 'D' });
    (prisma.stationDisplay.delete as jest.Mock).mockResolvedValue({});
    const svc = new DisplaysService(prisma as any, audit as any);
    await svc.remove('d1', actor);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPLAY_DELETED' }));
  });

  it('snapshotForToken: unknown token → null; disabled display exposes NO station data', async () => {
    const prisma = makePrisma();
    (prisma.stationDisplay.findUnique as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'd1', enabled: false, name: 'D', displayType: 'LIVE_STATION', station: { name: 'X' } });
    const svc = new DisplaysService(prisma as any, audit as any);
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

    const svc = new DisplaysService(prisma as any, audit as any);
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

    const svc = new DisplaysService(prisma as any, audit as any);
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

    const svc = new DisplaysService(prisma as any, audit as any);
    const snap = (await svc.snapshotForToken('tok')) as any;
    expect(snap.operation).toMatchObject({ label: 'BATCH BUILD', sessionCode: 'AYB-2' });
    expect(snap.progress).toBeNull();
    expect(snap.lastScan).toMatchObject({ kind: 'BATCH UNIT', code: 'SKU-9' });
  });

  it('fingerprint changes only when the snapshot content changes', () => {
    const a = { x: 1 };
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint({ x: 1 }));
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint({ x: 2 }));
  });

  it('offline threshold is bounded (90s) so stale screens show Offline', () => {
    expect(DISPLAY_OFFLINE_AFTER_MS).toBe(90_000);
  });
});
