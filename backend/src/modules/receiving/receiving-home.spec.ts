import { ReceivingService } from './receiving.service';

/**
 * RECEIVING HOME (automatic-dispatch worker feed) — unit tests with a mocked
 * prisma (no DB). The worker never picks an arrival / session; the home feed
 * carries the available PRODUCT + CARTON cards with live counters and a scan
 * auto-resolves the owning arrival/session. Lane separation is enforced:
 * the product path only resolves product cards and the carton path only
 * carton cards.
 */

function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(),
  });
  return {
    receivingSession: model(),
    expectedArrival: model(),
    expectedArrivalItem: model(),
    receivingProduct: model(),
    receivingScanEvent: model(),
    receivingCarton: model(),
    receivingDiscrepancy: model(),
    receivingWorkerLog: model(),
    warehouseCarton: model(),
    warehouseShipment: model(),
    workerTaskAssignment: model(),
    station: model(),
    user: model(),
    auditLog: model(),
  };
}

const ACTOR: any = { id: 'w-1', name: 'Worker One', canResolveDiscrepancy: false, ip: '10.0.0.1' };

/** One arrival with one expected product line and one carton. */
function arrival() {
  return {
    id: 'arr-1', code: 'WAR-001001', status: 'EXPECTED',
    customerId: 'CUS-1', customerName: 'Customer One', storeName: null,
    items: [
      { id: 'item-1', sku: 'SKU-1', reference: 'REF-1', productName: 'Product One', quantity: 2,
        category: 'SHOES', subcategory: null, categoryStatus: 'CONFIRMED',
        storeId: null, storeName: null },
    ],
    shipments: [
      { id: 's-1', code: 'SHP-1', trackingNumber: 'TRK-1', senderName: 'Sender Co',
        shippedAt: new Date('2026-09-05T10:00:00Z'), carrierName: 'DHL', carrierCode: 'DHL',
        externalShipmentId: 'EXT-1', senderCompany: 'Sender Co', totalCartons: 1, totalProducts: 1, totalUnits: 2,
        cartons: [
          { id: 'c-1', shipmentId: 's-1', externalCartonId: 'CTN-1', cartonReference: null,
            qrCodeValue: 'QR-1', barcodeValue: 'BC-1', cartonNumber: 1, totalCartons: 1,
            status: 'EXPECTED', weight: 12, weightUnit: 'KG', length: 40, width: 30, height: 20, dimensionUnit: 'CM' },
        ] },
    ],
  };
}

describe('ReceivingService HOME (automatic dispatch feed)', () => {
  let service: ReceivingService;
  let db: any;
  let audit: any;
  let assignments: any;
  let dispatch: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((action: any) => action(db));
    audit = { log: jest.fn() };
    assignments = { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn() };
    dispatch = { onReceivingCompleted: jest.fn() };
    service = new ReceivingService(db, audit, assignments, dispatch);

    // Open floor work: an arrival with NO receiving assignment rows is in
    // every receiving worker's scope (same policy assertOperationalAccess).
    db.expectedArrival.findMany.mockResolvedValue([arrival()]);
    db.workerTaskAssignment.findMany.mockResolvedValue([]);
    db.receivingProduct.findMany.mockResolvedValue([]);
    db.receivingSession.findFirst.mockResolvedValue(null);
  });

  describe('workerHome', () => {
    it('exposes product + carton cards with live counters and visible lists', async () => {
      const home = await service.workerHome('w-1', ACTOR);
      expect(home.productCardsPending).toBe(1);
      expect(home.cartonCardsPending).toBe(1);
      expect(home.productCards[0]).toMatchObject({ sku: 'SKU-1', reference: 'REF-1', expected: 2, remaining: 2 });
      expect(home.productCards[0].identifiers).toContain('SKU-1');
      expect(home.cartonCards[0]).toMatchObject({ externalCartonId: 'CTN-1', trackingNumber: 'TRK-1' });
      expect(home.cartonCards[0].identifiers).toEqual(expect.arrayContaining(['CTN-1', 'TRK-1']));
      // information-only lists
      expect(home.productList[0]).toMatchObject({ arrivalCode: 'WAR-001001', reference: 'SKU-1' });
      expect(home.cartonList[0]).toMatchObject({ arrivalCode: 'WAR-001001', reference: 'CTN-1', tracking: 'TRK-1' });
    });

    it('scopes cards to the worker: arrivals assigned to another worker are excluded', async () => {
      db.workerTaskAssignment.findMany.mockResolvedValue([
        { workerId: 'other-worker', status: 'ASSIGNED' },
      ]);
      const home = await service.workerHome('w-1', ACTOR);
      expect(home.productCardsPending).toBe(0);
      expect(home.cartonCardsPending).toBe(0);
    });

    it('scopes cards to the worker: the assigned worker keeps their arrival', async () => {
      db.workerTaskAssignment.findMany.mockResolvedValue([
        { workerId: 'w-1', status: 'ASSIGNED' },
      ]);
      const home = await service.workerHome('w-1', ACTOR);
      expect(home.productCardsPending).toBe(1);
      expect(home.cartonCardsPending).toBe(1);
    });

    it('does not count already-received cartons / completed product cards', async () => {
      const arr = arrival();
      arr.shipments[0].cartons[0].status = 'RECEIVED';
      db.expectedArrival.findMany.mockResolvedValue([arr]);
      // A seeded product line fully received.
      db.receivingProduct.findMany.mockResolvedValue([
        { id: 'p-1', session: { arrivalId: 'arr-1' }, sku: 'SKU-1', reference: 'REF-1',
          productName: 'Product One', category: 'SHOES', subcategory: null, categoryStatus: 'CONFIRMED',
          expectedQuantity: 2, receivedQuantity: 2 },
      ]);
      const home = await service.workerHome('w-1', ACTOR);
      expect(home.cartonCardsPending).toBe(0);
      expect(home.productCardsPending).toBe(0);
    });
  });

  describe('homeConfirmProduct', () => {
    it('resolves the owning arrival and confirms the product (auto session)', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: 'REF-1', expectedQuantity: 2, receivedQuantity: 0, difference: -2, status: 'EXPECTED',
        productName: 'Product One', category: null, subcategory: null, categoryStatus: 'CONFIRMED' };
      // Auto session: an existing RECEIVING session is reused (no start needed).
      db.receivingSession.findFirst.mockResolvedValue({ id: 'sess-1', code: 'RCV-000201', status: 'RECEIVING', arrivalId: 'arr-1' });
      // findProductArrival resolves the owning arrival via the expected line.
      db.receivingProduct.findFirst.mockResolvedValueOnce(null);
      db.expectedArrivalItem.findFirst.mockResolvedValue({ arrivalId: 'arr-1' });
      db.expectedArrival.findUnique.mockResolvedValue(arrival());
      // confirmProduct matches the product line.
      db.receivingProduct.findFirst.mockResolvedValueOnce(line);
      db.receivingScanEvent.findUnique.mockResolvedValue(null);
      db.receivingProduct.update.mockResolvedValue(line);
      db.receivingScanEvent.create.mockResolvedValue({});
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });
      db.receivingSession.findUnique.mockResolvedValue({
        ...{ id: 'sess-1', code: 'RCV-000201', status: 'RECEIVING', arrivalId: 'arr-1', shipmentId: null,
          deviceType: null, deviceName: null, scanSource: null, startedBy: 'w-1', startedAt: new Date(),
          pausedAt: null, completedAt: null, stationId: null },
        expectedArrival: arrival(), shipment: null, products: [], discrepancies: [],
      });
      db.receivingDiscrepancy.count.mockResolvedValue(0);
      db.receivingCarton.count.mockResolvedValue(0);
      db.receivingProduct.findMany.mockResolvedValue([]);

      const res = await service.homeConfirmProduct(
        { identifier: 'sku-1', identifierType: 'QR', source: 'CAMERA', operationId: 'op-1' }, ACTOR);

      expect(res.ok).toBe(true);
      expect(res.flash).toMatchObject({ kind: 'MATCH', cardType: 'PRODUCT' });
      // counters refreshed from the home feed
      expect(res.home).toBeTruthy();
      // authorization was enforced for the owning arrival
      expect(assignments.assertOperationalAccess).toHaveBeenCalledWith('w-1', 'receiving', { arrivalId: 'arr-1' });
    });

    it('a product scan with no matching card is a MISMATCH and confirms nothing', async () => {
      db.expectedArrivalItem.findFirst.mockResolvedValue(null);
      db.receivingProduct.findFirst.mockResolvedValue(null);
      const res = await service.homeConfirmProduct(
        { identifier: 'SKU-UNKNOWN', identifierType: 'QR' }, ACTOR);
      expect(res.ok).toBe(false);
      expect(res.flash).toMatchObject({ kind: 'MISMATCH', cardType: 'PRODUCT' });
      // no session / write created
      expect(db.receivingSession.create).not.toHaveBeenCalled();
    });
  });

  describe('homeConfirmCarton', () => {
    it('confirms a carton matched on QR code', async () => {
      db.warehouseCarton.findFirst.mockResolvedValue({
        id: 'c-1', shipmentId: 's-1', externalCartonId: 'CTN-1', cartonReference: null,
        qrCodeValue: 'QR-1', barcodeValue: 'BC-1', status: 'EXPECTED', cartonNumber: 1, totalCartons: 1,
        shipment: { arrivalId: 'arr-1', trackingNumber: 'TRK-1' },
      });
      // Auto session: an existing RECEIVING session is reused (no start needed).
      db.receivingSession.findFirst.mockResolvedValue({ id: 'sess-1', code: 'RCV-000201', status: 'RECEIVING', arrivalId: 'arr-1' });
      db.expectedArrival.findUnique.mockResolvedValue(arrival());
      db.receivingCarton.findUnique.mockResolvedValue(null);
      db.receivingCarton.create.mockResolvedValue({});
      db.warehouseCarton.update.mockResolvedValue({});
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });
      db.receivingSession.findUnique.mockResolvedValue({
        ...{ id: 'sess-1', code: 'RCV-000201', status: 'RECEIVING', arrivalId: 'arr-1', shipmentId: 's-1',
          deviceType: null, deviceName: null, scanSource: null, startedBy: 'w-1', startedAt: new Date(),
          pausedAt: null, completedAt: null, stationId: null },
        expectedArrival: arrival(), shipment: arrival().shipments[0], products: [], discrepancies: [],
      });
      db.receivingDiscrepancy.count.mockResolvedValue(0);
      db.receivingCarton.count.mockResolvedValue(0);
      db.receivingProduct.findMany.mockResolvedValue([]);

      const res = await service.homeConfirmCarton(
        { identifier: 'QR-1', identifierType: 'QR', source: 'CAMERA', operationId: 'op-2' }, ACTOR);
      expect(res.ok).toBe(true);
      expect(res.flash).toMatchObject({ kind: 'MATCH', cardType: 'CARTON' });
      expect(db.warehouseCarton.update).toHaveBeenCalled();
    });

    it('a carton scan with no matching carton is a MISMATCH (never a product confirm)', async () => {
      db.warehouseCarton.findFirst.mockResolvedValue(null);
      db.warehouseShipment.findFirst.mockResolvedValue(null);
      const res = await service.homeConfirmCarton(
        { identifier: 'CTN-UNKNOWN', identifierType: 'BARCODE' }, ACTOR);
      expect(res.ok).toBe(false);
      expect(res.flash).toMatchObject({ kind: 'MISMATCH', cardType: 'CARTON' });
      expect(db.receivingSession.create).not.toHaveBeenCalled();
    });
  });

  describe('homeMismatch', () => {
    it('audits a device mismatch even with no open session (nothing confirmed)', async () => {
      db.receivingSession.findFirst.mockResolvedValue(null);
      const res = await service.homeMismatch(
        { cardType: 'PRODUCT', identifier: 'SKU-UNKNOWN', identifierType: 'QR', source: 'CAMERA' }, ACTOR);
      expect(res.ok).toBe(true);
      expect(res.sessionId).toBeNull();
      expect(res.flash).toMatchObject({ kind: 'MISMATCH', cardType: 'PRODUCT' });
      expect(audit.log).toHaveBeenCalled();
    });
  });
});
