import { ReceivingService } from './receiving.service';

/**
 * REGRESSION — "cards reach Admin Web but never reach the Worker App".
 *
 * Two independent silent drops sat between a stored arrival and the worker
 * feed. Admin Web applies neither filter, which is exactly why the data
 * looked perfectly healthy in the browser while the handheld stayed empty.
 *
 *   1. dispatch() assigns an arrival to exactly ONE worker, and the feed
 *      hid held arrivals from everybody else.
 *   2. an expected item with neither SKU nor reference was `continue`d away,
 *      producing an arrival with zero product cards.
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
const ACTOR: any = { id: 'w-1', name: 'W', ip: null };

function item(over: any = {}) {
  return {
    id: 'i1', sku: 'SKU-1', reference: 'REF-1', productName: 'Widget', quantity: 2,
    category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW',
    storeId: null, storeName: null, ...over,
  };
}
function arrival(items: any[]) {
  return {
    id: 'arr-1', code: 'WAR-001001', status: 'EXPECTED', productCount: items.length,
    customerId: 'C', customerName: 'Cust', storeName: null, items, shipments: [],
  };
}

describe('CRM card reaches the worker feed', () => {
  let svc: ReceivingService; let db: any;
  beforeEach(() => {
    db = prisma(); db.$transaction = jest.fn((a: any) => a(db));
    svc = new ReceivingService(db, { log: jest.fn() } as any,
      { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn() } as any,
      { onReceivingCompleted: jest.fn() } as any);
    db.receivingProduct.findMany.mockResolvedValue([]);
  });

  it('CAUSE 1: an auto-dispatched arrival is visible to a non-assigned worker', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrival([item()])]);
    db.workerTaskAssignment.findMany.mockResolvedValue([{ workerId: 'worker-A', arrivalId: 'arr-1' }]);
    const home = await svc.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(1);
    expect(home.arrivals[0].isOwn).toBe(false);
  });

  it('CAUSE 1: the assignee still sees it, marked as their own', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrival([item()])]);
    db.workerTaskAssignment.findMany.mockResolvedValue([{ workerId: 'w-1', arrivalId: 'arr-1' }]);
    const home = await svc.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(1);
    expect(home.arrivals[0].isOwn).toBe(true);
  });

  it('CAUSE 2: an item with no SKU and no reference still becomes a card', async () => {
    db.expectedArrival.findMany.mockResolvedValue([
      arrival([item({ id: 'i9', sku: null, reference: null, productName: 'Unlabelled', quantity: 3 })]),
    ]);
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    const home = await svc.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(1);
    const card: any = home.productCards[0];
    expect(card.remaining).toBe(3);
    expect(card.categoryStatus).toBe('NEEDS_REVIEW');
  });

  it('CAUSE 2: identifier-less lines stay SEPARATE cards, identified lines still merge', async () => {
    db.expectedArrival.findMany.mockResolvedValue([
      arrival([
        item({ id: 'a', sku: null, reference: null, productName: 'One', quantity: 1 }),
        item({ id: 'b', sku: null, reference: null, productName: 'Two', quantity: 1 }),
        item({ id: 'c', sku: 'SKU-9', reference: null, quantity: 2 }),
        item({ id: 'd', sku: 'SKU-9', reference: null, quantity: 5 }),
      ]),
    ]);
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    const home = await svc.workerHome('w-1', ACTOR);
    // 2 distinct unlabelled cards + 1 merged SKU-9 card of qty 7.
    expect(home.productCardsPending).toBe(3);
    const merged: any = home.productCards.find((c: any) => c.sku === 'SKU-9');
    expect(merged.remaining).toBe(7);
  });

  it('a fully open-floor arrival is unaffected (no regression)', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrival([item()])]);
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    const home = await svc.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(1);
    expect(home.arrivals[0].isOwn).toBe(true);
  });
});
