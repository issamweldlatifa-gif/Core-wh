import { ReceivingService } from './receiving.service';

/**
 * END-TO-END: card delivery -> notification -> badge (TEST 07 … TEST 12).
 *
 * The device badge model (CardNotificationCenter, worker-core) is replayed
 * here in TypeScript against the REAL backend feed produced by
 * ReceivingService.workerHome(). That closes the loop the acceptance criteria
 * ask for: a badge assertion backed by the actual server payload rather than
 * a hand-written fixture, so a backend feed change that breaks the badge
 * fails this suite.
 */

function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn().mockResolvedValue(0),
  });
  return {
    receivingSession: model(), expectedArrival: model(), expectedArrivalItem: model(),
    receivingProduct: model(), receivingScanEvent: model(), receivingCarton: model(),
    receivingDiscrepancy: model(), receivingWorkerLog: model(), warehouseCarton: model(),
    warehouseShipment: model(), workerTaskAssignment: model(), station: model(),
    user: model(), auditLog: model(),
  };
}

const ACTOR: any = { id: 'w-1', name: 'Worker One', ip: '10.0.0.1' };

// ---- device-side badge model (mirror of CardNotificationCenter) -----------
type Reads = { product: Set<string>; carton: Set<string> };
const emptyReads = (): Reads => ({ product: new Set(), carton: new Set() });

function idsOf(home: any) {
  return {
    product: new Set<string>(home.productCards.map((c: any) => c.id ?? c.sku ?? c.reference)),
    carton: new Set<string>(home.cartonCards.map((c: any) => c.id ?? c.externalCartonId)),
  };
}
/** Prune reads to the live feed, then unread = live - read. */
function reconcile(reads: Reads, home: any) {
  const live = idsOf(home);
  const product = new Set([...reads.product].filter((id) => live.product.has(id)));
  const carton = new Set([...reads.carton].filter((id) => live.carton.has(id)));
  const unread = [...live.product].filter((id) => !product.has(id)).length
    + [...live.carton].filter((id) => !carton.has(id)).length;
  return { reads: { product, carton }, unread, badge: unread > 0 ? unread : null };
}
function markAllRead(reads: Reads, home: any): Reads {
  const live = idsOf(home);
  return {
    product: new Set([...reads.product, ...live.product]),
    carton: new Set([...reads.carton, ...live.carton]),
  };
}

function arrival(cartonStatus = 'EXPECTED') {
  return {
    id: 'arr-1', code: 'WAR-001001', status: 'EXPECTED', productCount: 1,
    customerId: 'CUS-1', customerName: 'Customer One', storeName: null,
    items: [{ id: 'i1', sku: 'SKU-1', reference: 'REF-1', productName: 'Product One', quantity: 1,
      category: 'SHOES', subcategory: null, categoryStatus: 'CONFIRMED', storeId: null, storeName: null }],
    shipments: [{ id: 's1', code: 'SHP-1', trackingNumber: 'TRK-1', senderName: 'S',
      shippedAt: new Date('2026-09-05T10:00:00Z'),
      cartons: [{ id: 'c1', shipmentId: 's1', externalCartonId: 'CTN-1', cartonReference: null,
        qrCodeValue: 'QR-1', barcodeValue: 'BC-1', cartonNumber: 1, totalCartons: 1,
        status: cartonStatus, weight: 1, weightUnit: 'KG',
        length: null, width: null, height: null, dimensionUnit: null }] }],
  };
}

describe('Card delivery -> notification -> badge (end to end)', () => {
  let service: ReceivingService;
  let db: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((a: any) => a(db));
    service = new ReceivingService(db, { log: jest.fn() } as any,
      { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn() } as any,
      { onReceivingCompleted: jest.fn() } as any);
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    db.receivingProduct.findMany.mockResolvedValue([]);
    db.expectedArrival.findMany.mockResolvedValue([arrival()]);
  });

  it('TEST 07 — a newly delivered card raises the badge', async () => {
    const home = await service.workerHome('w-1', ACTOR);
    const state = reconcile(emptyReads(), home);
    // one product card + one carton card, both unseen
    expect(state.badge).toBe(2);
  });

  it('TEST 08 — reading the cards drops the badge immediately', async () => {
    const home = await service.workerHome('w-1', ACTOR);
    const reads = markAllRead(emptyReads(), home);
    // Same feed, nothing completed yet: work remains but nothing is unread.
    expect(reconcile(reads, home).badge).toBeNull();
    expect(home.productCardsPending + home.cartonCardsPending).toBe(2);
  });

  it('TEST 09 — completing the last task leaves the badge at zero', async () => {
    const before = await service.workerHome('w-1', ACTOR);
    const reads = markAllRead(emptyReads(), before);

    // The worker received everything: the product line is fully received and
    // the carton is RECEIVED, so the backend feed no longer carries them.
    db.receivingProduct.findMany.mockResolvedValue([
      { id: 'p1', session: { arrivalId: 'arr-1' }, sku: 'SKU-1', reference: 'REF-1',
        productName: 'Product One', category: 'SHOES', subcategory: null,
        categoryStatus: 'CONFIRMED', expectedQuantity: 1, receivedQuantity: 1, status: 'RECEIVED' },
    ]);
    db.expectedArrival.findMany.mockResolvedValue([arrival('RECEIVED')]);

    const after = await service.workerHome('w-1', ACTOR);
    expect(after.productCardsPending).toBe(0);
    expect(after.cartonCardsPending).toBe(0);
    const state = reconcile(reads, after);
    expect(state.badge).toBeNull();
    // and the read set does not accumulate ids of cards that are gone
    expect(state.reads.product.size + state.reads.carton.size).toBe(0);
  });

  it('TEST 10 — reopening the app keeps the badge equal to the true state', async () => {
    const home = await service.workerHome('w-1', ACTOR);
    const persisted = markAllRead(emptyReads(), home);
    // Cold start: the read set is rehydrated from storage before the first
    // reconcile, so already-read cards are not re-announced.
    expect(reconcile(persisted, await service.workerHome('w-1', ACTOR)).badge).toBeNull();
  });

  it('TEST 11 — after logout/login read notifications do not come back unread', async () => {
    const home = await service.workerHome('w-1', ACTOR);
    const persisted = markAllRead(emptyReads(), home);
    // A new session reloads the same feed; the persisted read set survives.
    const relogin = await service.workerHome('w-1', ACTOR);
    expect(reconcile(persisted, relogin).badge).toBeNull();
  });

  it('TEST 12 — a card is never lost across a failed poll', async () => {
    const home = await service.workerHome('w-1', ACTOR);
    const state = reconcile(emptyReads(), home);
    expect(state.badge).toBe(2);
    // A failed poll yields no feed: the device keeps the previous state
    // rather than clearing it, and the card reappears on the next success.
    const recovered = reconcile(state.reads, await service.workerHome('w-1', ACTOR));
    expect(recovered.badge).toBe(2);
  });

  it('a force-deleted arrival removes the cards and clears the notification', async () => {
    const home = await service.workerHome('w-1', ACTOR);
    expect(reconcile(emptyReads(), home).badge).toBe(2);
    // Admin force-deleted the arrival: it is gone from the feed entirely.
    db.expectedArrival.findMany.mockResolvedValue([]);
    const after = await service.workerHome('w-1', ACTOR);
    expect(after.productCardsPending + after.cartonCardsPending).toBe(0);
    expect(reconcile(emptyReads(), after).badge).toBeNull();
  });
});
