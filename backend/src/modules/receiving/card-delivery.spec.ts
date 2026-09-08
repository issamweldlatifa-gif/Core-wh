import { ReceivingService } from './receiving.service';

/**
 * UNIFIED CARD DELIVERY PIPELINE — delivery matrix (TEST 01 … TEST 06).
 *
 * These tests exercise the single pipeline that both card types travel on:
 *
 *   ADMIN/CRM -> ExpectedArrival (+ shipments/cartons)
 *             -> workerArrivals()  (scope: assignment / open floor)
 *             -> workerHome()      (PRODUCT + CARTON cards, counters)
 *             -> Worker app feed
 *
 * PRODUCT and CARTON differ ONLY by card type: the scope resolution, the
 * pending counters and the delivery path are shared. The regression these
 * lock down is a scope filter that dropped BOTH lanes at once.
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

/** An arrival carrying `products` product lines and `cartons` cartons. */
function arrivalWith(id: string, code: string, products: number, cartons: number) {
  return {
    id, code, status: 'EXPECTED',
    customerId: 'CUS-1', customerName: 'Customer One', storeName: null,
    productCount: products,
    items: Array.from({ length: products }, (_, i) => ({
      id: `${id}-item-${i}`, sku: `${code}-SKU-${i}`, reference: `${code}-REF-${i}`,
      productName: `Product ${i}`, quantity: 1, category: 'SHOES', subcategory: null,
      categoryStatus: 'CONFIRMED', storeId: null, storeName: null,
    })),
    shipments: cartons === 0 ? [] : [{
      id: `${id}-s1`, code: 'SHP-1', trackingNumber: `${code}-TRK`, senderName: 'Sender Co',
      shippedAt: new Date('2026-09-05T10:00:00Z'),
      cartons: Array.from({ length: cartons }, (_, i) => ({
        id: `${id}-c-${i}`, shipmentId: `${id}-s1`, externalCartonId: `${code}-CTN-${i}`,
        cartonReference: null, qrCodeValue: `${code}-QR-${i}`, barcodeValue: `${code}-BC-${i}`,
        cartonNumber: i + 1, totalCartons: cartons, status: 'EXPECTED',
        weight: 1, weightUnit: 'KG', length: null, width: null, height: null, dimensionUnit: null,
      })),
    }],
  };
}

describe('Unified card delivery pipeline (delivery matrix)', () => {
  let service: ReceivingService;
  let db: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((action: any) => action(db));
    service = new ReceivingService(db, { log: jest.fn() } as any,
      { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn() } as any,
      { onReceivingCompleted: jest.fn() } as any);
    // Open floor: no assignment holds these arrivals.
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    db.receivingProduct.findMany.mockResolvedValue([]);
  });

  it('TEST 01 — a PRODUCT-only arrival delivers its product cards', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrivalWith('a1', 'WAR-1', 2, 0)]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(2);
    expect(home.cartonCardsPending).toBe(0);
  });

  it('TEST 02 — a CARTON-only arrival delivers its carton cards', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrivalWith('a1', 'WAR-1', 0, 3)]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.cartonCardsPending).toBe(3);
    expect(home.productCardsPending).toBe(0);
  });

  it('TEST 03 — PRODUCT and CARTON arrive together, neither lane is lost', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrivalWith('a1', 'WAR-1', 2, 2)]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(2);
    expect(home.cartonCardsPending).toBe(2);
  });

  it('TEST 04 — many PRODUCT cards: none missing, none duplicated', async () => {
    db.expectedArrival.findMany.mockResolvedValue([
      arrivalWith('a1', 'WAR-1', 3, 0),
      arrivalWith('a2', 'WAR-2', 4, 0),
    ]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(7);
    const ids = home.productCards.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('TEST 05 — many CARTON cards: none missing, none duplicated', async () => {
    db.expectedArrival.findMany.mockResolvedValue([
      arrivalWith('a1', 'WAR-1', 0, 3),
      arrivalWith('a2', 'WAR-2', 0, 5),
    ]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.cartonCardsPending).toBe(8);
    const ids = home.cartonCards.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('TEST 06 — mixed arrivals deliver every card of both types at once', async () => {
    db.expectedArrival.findMany.mockResolvedValue([
      arrivalWith('a1', 'WAR-1', 2, 1),
      arrivalWith('a2', 'WAR-2', 1, 3),
    ]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(3);
    expect(home.cartonCardsPending).toBe(4);
    // The counters and the card arrays are always consistent — the counter is
    // derived from the delivered cards, never from a separate global query.
    expect(home.productCards).toHaveLength(home.productCardsPending);
    expect(home.cartonCards).toHaveLength(home.cartonCardsPending);
  });

  it('an arrival held by another worker hides BOTH of its lanes, not just one', async () => {
    db.expectedArrival.findMany.mockResolvedValue([arrivalWith('a1', 'WAR-1', 2, 2)]);
    db.workerTaskAssignment.findMany.mockResolvedValue([{ workerId: 'other', arrivalId: 'a1' }]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(0);
    expect(home.cartonCardsPending).toBe(0);
  });

  it('a worker sees their own held arrival plus unheld open-floor work', async () => {
    db.expectedArrival.findMany.mockResolvedValue([
      arrivalWith('a1', 'WAR-1', 1, 1), // held by w-1
      arrivalWith('a2', 'WAR-2', 1, 1), // open floor
      arrivalWith('a3', 'WAR-3', 1, 1), // held by someone else
    ]);
    db.workerTaskAssignment.findMany.mockResolvedValue([
      { workerId: 'w-1', arrivalId: 'a1' },
      { workerId: 'other', arrivalId: 'a3' },
    ]);
    const home = await service.workerHome('w-1', ACTOR);
    expect(home.productCardsPending).toBe(2);
    expect(home.cartonCardsPending).toBe(2);
    expect(home.arrivals.map((a: any) => a.code).sort()).toEqual(['WAR-1', 'WAR-2']);
  });
});
