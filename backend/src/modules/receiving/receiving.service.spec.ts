import { ConflictException } from '@nestjs/common';
import { ReceivingService } from './receiving.service';

/**
 * Card-based Receiving (device-side matching rebuild) — unit tests
 * (mocked prisma, no DB).
 *
 * Covers the rebuild contract:
 *   PRODUCT lane  : QR / barcode / OCR-SKU / OCR-ref → MATCH · mismatch →
 *                   MISMATCH (log failure) · completed card → reject
 *   CARTON lane   : tracking / QR / barcode / carton ref → MATCH · mismatch
 *                   → MISMATCH · wrong carton (other arrival) · completed →
 *                   reject · ambiguous tracking
 *   both lanes    : idempotency (operationId) · worker activity log rows
 *   complete      : duplicate completion rejected
 */

function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn(),
  });
  return {
    receivingSession: model(),
    expectedArrival: model(),
    receivingProduct: model(),
    receivingScanEvent: model(),
    receivingCarton: model(),
    receivingDiscrepancy: model(),
    receivingWorkerLog: model(),
    warehouseCarton: model(),
    warehouseShipment: model(),
    station: model(),
    user: model(),
    auditLog: model(),
  };
}

const SESSION_ROW = {
  id: 'sess-1', code: 'RCV-000201', status: 'RECEIVING', arrivalId: 'arr-1',
  shipmentId: 's-1', deviceType: 'ANDROID_TERMINAL', deviceName: 'CT40-X',
  scanSource: null, stationId: null, startedBy: 'w-1',
  startedAt: new Date('2026-09-07T08:00:00Z'), pausedAt: null, completedAt: null,
};

const ACTOR = { id: 'w-1', name: 'Worker One', canResolveDiscrepancy: false, ip: '10.0.0.1' };

/** Session row as returned by prisma (relations included). */
function fullSession(): any {
  const a = baseArrival();
  return {
    ...SESSION_ROW,
    expectedArrival: a,
    shipment: a.shipments[0],
    products: [],
    discrepancies: [],
  };
}

function baseArrival(overrides: any = {}) {
  return {
    id: 'arr-1', code: 'WAR-2026-0001', status: 'RECEIVING',
    externalArrivalId: 'ARR-1', arrivalId: 'ARR-1',
    customerId: 'CUS-1', customerName: 'Customer One', storeName: 'Store One',
    shipments: [
      {
        id: 's-1', code: 'SHP-1', externalShipmentId: 'EXT-SHP-1',
        carrierName: 'DHL', carrierCode: 'DHL', trackingNumber: 'TRK-1',
        senderName: 'Sender Co', senderCompany: 'Sender Co',
        shippedAt: new Date('2026-09-05T10:00:00Z'),
        totalCartons: 2, totalProducts: 2, totalUnits: 4,
        cartons: [
          {
            id: 'c-1', shipmentId: 's-1', externalCartonId: 'CTN-1', cartonReference: 'REF-CTN-1',
            qrCodeValue: 'QR-CTN-1', barcodeValue: 'BC-CTN-1',
            cartonNumber: 1, totalCartons: 2, status: 'EXPECTED',
            weight: 12, weightUnit: 'KG', length: 40, width: 30, height: 20, dimensionUnit: 'CM',
          },
          {
            id: 'c-2', shipmentId: 's-1', externalCartonId: 'CTN-2', cartonReference: 'REF-CTN-2',
            qrCodeValue: 'QR-CTN-2', barcodeValue: 'BC-CTN-2',
            cartonNumber: 2, totalCartons: 2, status: 'EXPECTED',
            weight: null, weightUnit: null, length: null, width: null, height: null, dimensionUnit: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('ReceivingService (card-based, device-side matching)', () => {
  let service: ReceivingService;
  let db: any;
  let audit: { log: jest.Mock };
  let assignments: any;
  let dispatch: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((action: any) => action(db));
    audit = { log: jest.fn() };
    assignments = {
      assertOperationalAccess: jest.fn(),
      receivingStarted: jest.fn(),
      receivingCompleted: jest.fn(),
    };
    dispatch = { onReceivingCompleted: jest.fn() };
    service = new ReceivingService(db, audit as never, assignments as never, dispatch as never);

    // sessionDetail chain (called by every confirm/report endpoint at the end)
    db.receivingSession.findUnique.mockResolvedValue(fullSession());
    db.receivingProduct.findMany.mockResolvedValue([]);
    db.receivingDiscrepancy.count.mockResolvedValue(0);
    db.receivingCarton.count.mockResolvedValue(0);
    db.expectedArrival.findUnique.mockResolvedValue(baseArrival());
    db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });
  });

  const workerLogs = () => db.receivingWorkerLog.create.mock.calls.map((c: any) => c[0].data);
  const auditActions = () => audit.log.mock.calls.map((c: any) => c[0].action);

  // ============================ PRODUCT LANE ============================
  describe('confirmProduct (PRODUIT lane)', () => {
    it('QR scan matches a product card -> MATCH persisted + worker log', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: null, expectedQuantity: 2, receivedQuantity: 0, difference: -2, status: 'EXPECTED' };
      db.receivingProduct.findFirst.mockResolvedValue(line);
      db.receivingProduct.update.mockResolvedValue(line);
      db.receivingScanEvent.create.mockResolvedValue({ id: 'ev-1' });
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmProduct('sess-1', {
        identifier: ' SKU-1 ', identifierType: 'QR', source: 'EXTERNAL_SCANNER',
        operationId: 'op-1', startedAt: '2026-09-07T08:00:02.000Z',
      }, ACTOR);

      // persisted receipt
      // Guarded by the quantity the update was computed from, so two
      // concurrent workers can never both apply the same unit.
      expect(db.receivingProduct.updateMany).toHaveBeenCalledWith({
        where: { id: 'p-1', receivedQuantity: 0 },
        data: { receivedQuantity: 1, difference: -1, status: 'PARTIALLY_RECEIVED' },
      });
      // idempotency event
      expect(db.receivingScanEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ operationId: 'op-1', kind: 'PRODUCT', code: 'SKU-1' }),
      }));
      // worker activity log row
      expect(workerLogs()).toHaveLength(1);
      expect(workerLogs()[0]).toMatchObject({
        cardType: 'PRODUCT', cardRef: 'SKU-1', operation: 'CONFIRM',
        identifierType: 'QR', identifierValue: 'SKU-1', result: 'MATCH',
        workerId: 'w-1', workerName: 'Worker One', deviceType: 'ANDROID_TERMINAL',
      });
      // duration = server verdict time - device-reported scan start (clamped >= 0)
      expect(typeof workerLogs()[0].durationMs).toBe('number');
      expect(workerLogs()[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(workerLogs()[0].startedAt).toBeInstanceOf(Date);
      expect(workerLogs()[0].endedAt).toBeInstanceOf(Date);
      // audit + flash
      expect(auditActions()).toContain('PRODUCT_RECEIVED');
      expect(res.flash).toMatchObject({ kind: 'MATCH', cardType: 'PRODUCT', code: 'SKU-1', received: 1, expected: 2 });
    });

    it('barcode + OCR identifier types are recorded in the worker log', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: null, expectedQuantity: 5, receivedQuantity: 0, difference: -5, status: 'EXPECTED' };
      db.receivingProduct.findFirst.mockResolvedValue(line);
      db.receivingProduct.update.mockResolvedValue(line);

      await service.confirmProduct('sess-1', { identifier: 'SKU-1', identifierType: 'BARCODE' }, ACTOR);
      await service.confirmProduct('sess-1', { identifier: 'SKU-1', identifierType: 'OCR', source: 'OCR_CONFIRMED' }, ACTOR);

      const types = workerLogs().map((l) => l.identifierType);
      expect(types).toEqual(['BARCODE', 'OCR']);
    });

    it('OCR-read REFERENCE matches the product card (reference is a first-class identifier)', async () => {
      const line = { id: 'p-2', sku: 'SKU-9', reference: 'REF-9', expectedQuantity: 1, receivedQuantity: 0, difference: -1, status: 'EXPECTED' };
      db.receivingProduct.findFirst.mockResolvedValue(line);
      db.receivingProduct.update.mockResolvedValue({ ...line, receivedQuantity: 1 });

      const res = await service.confirmProduct('sess-1', { identifier: 'ref-9', identifierType: 'OCR' }, ACTOR);
      // case-insensitive comparison (mode: 'insensitive'), stored value untouched
      expect(db.receivingProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { sku: { equals: 'ref-9', mode: 'insensitive' } },
            { reference: { equals: 'ref-9', mode: 'insensitive' } },
          ],
        }),
      }));
      expect(res.flash).toMatchObject({ kind: 'MATCH', code: 'SKU-9' });
    });

    it('wrong identifier -> MISMATCH: nothing confirmed, failure logged', async () => {
      db.receivingProduct.findFirst.mockResolvedValue(null);
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmProduct('sess-1', { identifier: 'SKU-NOPE', identifierType: 'QR' }, ACTOR);

      expect(db.receivingProduct.update).not.toHaveBeenCalled();
      expect(db.receivingScanEvent.create).not.toHaveBeenCalled();
      expect(workerLogs()).toHaveLength(1);
      expect(workerLogs()[0]).toMatchObject({ cardType: 'PRODUCT', cardRef: null, result: 'MISMATCH', operation: 'CONFIRM' });
      expect(auditActions()).toContain('UNEXPECTED_PRODUCT');
      expect(res.flash).toMatchObject({ kind: 'MISMATCH', cardType: 'PRODUCT', code: 'SKU-NOPE' });
    });

    it('completed product card -> REJECTED (no duplicate completion)', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: null, expectedQuantity: 2, receivedQuantity: 2, difference: 0, status: 'RECEIVED' };
      db.receivingProduct.findFirst.mockResolvedValue(line);
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmProduct('sess-1', { identifier: 'SKU-1', identifierType: 'QR' }, ACTOR);

      expect(db.receivingProduct.update).not.toHaveBeenCalled();
      expect(workerLogs()[0]).toMatchObject({ cardRef: 'SKU-1', operation: 'DUPLICATE_REJECT', result: 'DUPLICATE' });
      expect(auditActions()).toContain('CARD_ALREADY_COMPLETED');
      expect(res.flash).toMatchObject({ kind: 'CARD_ALREADY_COMPLETE', cardType: 'PRODUCT' });
    });

    it('same unit-distinct identifier twice -> UNIT_ALREADY_SCANNED (never counted)', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: null, expectedQuantity: 5, receivedQuantity: 1, difference: -4, status: 'PARTIALLY_RECEIVED' };
      db.receivingProduct.findFirst.mockResolvedValue(line);
      // The exact unit was already MATCHED on this arrival (any worker).
      db.receivingWorkerLog.findFirst.mockResolvedValue({ id: 'log-first' });
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-2' });

      const res = await service.confirmProduct('sess-1', { identifier: 'SER-001', identifierType: 'QR' }, ACTOR);

      expect(db.receivingWorkerLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ cardType: 'PRODUCT', result: 'MATCH' }),
      }));
      expect(db.receivingProduct.update).not.toHaveBeenCalled();
      expect(db.receivingProduct.updateMany).not.toHaveBeenCalled();
      expect(workerLogs()[0]).toMatchObject({ operation: 'DUPLICATE_REJECT', result: 'DUPLICATE', identifierValue: 'SER-001' });
      expect(auditActions()).toContain('UNIT_ALREADY_SCANNED');
      expect(res.flash).toMatchObject({ kind: 'UNIT_ALREADY_SCANNED', cardType: 'PRODUCT', code: 'SER-001' });
    });

    it('model codes keep counting even when the same value matched before (count workflow preserved)', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: null, expectedQuantity: 5, receivedQuantity: 1, difference: -4, status: 'PARTIALLY_RECEIVED' };
      db.receivingProduct.findFirst.mockResolvedValue(line);
      db.receivingProduct.update.mockResolvedValue(line);
      db.receivingWorkerLog.findFirst.mockResolvedValue({ id: 'log-first' });
      db.receivingScanEvent.create.mockResolvedValue({ id: 'ev-1' });
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-2' });

      const res = await service.confirmProduct('sess-1', { identifier: 'SKU-1', identifierType: 'QR' }, ACTOR);

      expect(res.flash).toMatchObject({ kind: 'MATCH', cardType: 'PRODUCT' });
      expect(db.receivingProduct.updateMany).toHaveBeenCalled();
    });

    it('overage creates a discrepancy and records MATCH', async () => {
      const line = { id: 'p-1', sku: 'SKU-1', reference: null, expectedQuantity: 1, receivedQuantity: 1, difference: 0, status: 'PARTIALLY_RECEIVED' };
      // received(1) >= expected(1) is the completed gate; use expected 2 / received 1 + qty 2.
      const line2 = { ...line, expectedQuantity: 2 };
      db.receivingProduct.findFirst.mockResolvedValue(line2);
      db.receivingProduct.update.mockResolvedValue({ ...line2, receivedQuantity: 3 });
      db.receivingDiscrepancy.create.mockResolvedValue({ id: 'd-1' });

      await service.confirmProduct('sess-1', { identifier: 'SKU-1', quantity: 2 }, ACTOR);
      expect(db.receivingProduct.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ receivedQuantity: 3, status: 'OVERAGE' }),
      }));
      expect(db.receivingDiscrepancy.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ type: 'OVERAGE' }),
      }));
    });

    it('replayed operationId is idempotent (no second observation, no second log)', async () => {
      db.receivingScanEvent.findUnique.mockResolvedValue({ id: 'ev-1', sessionId: 'sess-1' });

      await service.confirmProduct('sess-1', { identifier: 'SKU-1', operationId: 'op-1' }, ACTOR);

      expect(db.receivingProduct.findFirst).not.toHaveBeenCalled();
      expect(workerLogs()).toHaveLength(0);
      expect(db.receivingScanEvent.create).not.toHaveBeenCalled();
    });
  });

  // ============================ CARTON LANE ============================
  describe('confirmCarton (CARTON lane)', () => {
    const cartonMatch = (status: string = 'EXPECTED') => ({
      ...baseArrival(),
      shipments: [{
        ...baseArrival().shipments[0],
        cartons: [{ ...baseArrival().shipments[0].cartons[0], status }],
      }],
    });

    it('tracking number matches the single open carton -> MATCH', async () => {
      db.expectedArrival.findUnique.mockResolvedValue(cartonMatch());
      db.receivingCarton.create.mockResolvedValue({ id: 'rc-1' });
      db.warehouseCarton.update.mockResolvedValue({});

      const res = await service.confirmCarton('sess-1', {
        identifier: 'TRK-1', identifierType: 'BARCODE', operationId: 'op-c1',
      }, ACTOR);

      expect(db.receivingCarton.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ cartonId: 'c-1', status: 'RECEIVED', scannedCode: 'CTN-1' }),
      }));
      expect(db.warehouseCarton.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'c-1' }, data: expect.objectContaining({ status: 'RECEIVED' }),
      }));
      expect(workerLogs()[0]).toMatchObject({ cardType: 'CARTON', cardRef: 'CTN-1', result: 'MATCH' });
      expect(res.flash).toMatchObject({ kind: 'MATCH', cardType: 'CARTON', code: 'CTN-1' });
    });

    it.each([
      ['QR', 'QR-CTN-1'],
      ['BARCODE', 'BC-CTN-1'],
      ['MANUAL', 'REF-CTN-1'],
      ['QR', 'ctn-1'], // external carton id, case-insensitive
    ])('carton card %s identifier (%s) -> MATCH', async (idType, value) => {
      db.expectedArrival.findUnique.mockResolvedValue(cartonMatch());
      db.receivingCarton.create.mockResolvedValue({ id: 'rc-1' });

      const res = await service.confirmCarton('sess-1', { identifier: value, identifierType: idType as never }, ACTOR);
      expect(res.flash).toMatchObject({ kind: 'MATCH', code: 'CTN-1' });
      // The logged identifier is the normalized (whitespace-trimmed) scan value.
      expect(workerLogs()[0]).toMatchObject({ result: 'MATCH', identifierValue: value });
    });

    it('tracking with several open cartons -> AMBIGUOUS (scan the specific carton)', async () => {
      db.expectedArrival.findUnique.mockResolvedValue(baseArrival()); // 2 open cartons on TRK-1
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmCarton('sess-1', { identifier: 'TRK-1' }, ACTOR);

      expect(db.receivingCarton.create).not.toHaveBeenCalled();
      expect(workerLogs()[0]).toMatchObject({ cardType: 'CARTON', result: 'AMBIGUOUS' });
      expect(res.flash).toMatchObject({ kind: 'TRACKING_AMBIGUOUS', cartons: expect.arrayContaining([
        expect.objectContaining({ externalCartonId: 'CTN-1' }),
        expect.objectContaining({ externalCartonId: 'CTN-2' }),
      ]) });
    });

    it('tracking whose cartons are all received -> completed-card REJECT', async () => {
      db.expectedArrival.findUnique.mockResolvedValue(cartonMatch('RECEIVED'));
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmCarton('sess-1', { identifier: 'TRK-1' }, ACTOR);

      expect(db.receivingCarton.create).not.toHaveBeenCalled();
      expect(workerLogs()[0]).toMatchObject({ result: 'DUPLICATE', operation: 'DUPLICATE_REJECT' });
      expect(auditActions()).toContain('CARD_ALREADY_COMPLETED');
      expect(res.flash).toMatchObject({ kind: 'CARD_ALREADY_COMPLETE' });
    });

    it('already-received carton card -> REJECTED (never counted twice)', async () => {
      db.expectedArrival.findUnique.mockResolvedValue(cartonMatch('RECEIVED'));
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmCarton('sess-1', { identifier: 'QR-CTN-1' }, ACTOR);

      expect(db.receivingCarton.create).not.toHaveBeenCalled();
      expect(workerLogs()[0]).toMatchObject({ cardRef: 'CTN-1', result: 'DUPLICATE' });
      expect(res.flash).toMatchObject({ kind: 'CARD_ALREADY_COMPLETE' });
    });

    it('unknown identifier -> MISMATCH (failure logged, nothing confirmed)', async () => {
      db.expectedArrival.findUnique.mockResolvedValue(baseArrival());
      db.warehouseCarton.findFirst.mockResolvedValue(null);
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmCarton('sess-1', { identifier: 'NOPE-1' }, ACTOR);

      expect(db.receivingCarton.create).not.toHaveBeenCalled();
      expect(workerLogs()[0]).toMatchObject({ cardType: 'CARTON', cardRef: null, result: 'MISMATCH' });
      expect(auditActions()).toContain('UNKNOWN_CARTON');
      expect(res.flash).toMatchObject({ kind: 'MISMATCH', cardType: 'CARTON' });
    });

    it('carton belonging to another arrival -> MISMATCH with WRONG SHIPMENT detail', async () => {
      db.expectedArrival.findUnique.mockResolvedValue(baseArrival());
      db.warehouseCarton.findFirst.mockResolvedValue({
        id: 'c-x', externalCartonId: 'CTN-X', shipment: { id: 's-x', code: 'SHP-X', arrivalId: 'arr-OTHER' },
      });
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.confirmCarton('sess-1', { identifier: 'CTN-X' }, ACTOR);

      expect(workerLogs()[0]).toMatchObject({ result: 'MISMATCH' });
      expect(auditActions()).toContain('WRONG_SHIPMENT');
      expect(res.flash).toMatchObject({ kind: 'WRONG_SHIPMENT', shipment: expect.objectContaining({ code: 'SHP-X' }) });
    });

    it('replayed carton operationId is idempotent', async () => {
      db.receivingCarton.findUnique.mockResolvedValue({ id: 'rc-1', receivingSessionId: 'sess-1' });

      const res = await service.confirmCarton('sess-1', { identifier: 'QR-CTN-1', operationId: 'op-c1' }, ACTOR);

      // No new observation, no new log row, no carton state change, no flash.
      expect(workerLogs()).toHaveLength(0);
      expect(db.receivingCarton.create).not.toHaveBeenCalled();
      expect(db.warehouseCarton.update).not.toHaveBeenCalled();
      expect(res.flash).toBeNull();
    });
  });

  // ============================ MISMATCH ENDPOINT ============================
  describe('reportMismatch (device local failure)', () => {
    it('logs the failure and changes no state', async () => {
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });

      const res = await service.reportMismatch('sess-1', {
        cardType: 'PRODUCT', identifier: 'SKU-999', identifierType: 'OCR', source: 'OCR_CONFIRMED',
      }, ACTOR);

      expect(workerLogs()[0]).toMatchObject({
        cardType: 'PRODUCT', operation: 'SCAN_REJECT', result: 'MISMATCH',
        identifierType: 'OCR', identifierValue: 'SKU-999',
      });
      expect(auditActions()).toContain('UNEXPECTED_PRODUCT');
      expect(db.receivingProduct.update).not.toHaveBeenCalled();
      expect(res.flash).toMatchObject({ kind: 'MISMATCH', cardType: 'PRODUCT' });
    });

    it('CARTON type mismatch logs against the carton lane', async () => {
      db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });
      await service.reportMismatch('sess-1', { cardType: 'CARTON', identifier: 'CTN-999' }, ACTOR);
      expect(workerLogs()[0]).toMatchObject({ cardType: 'CARTON', result: 'MISMATCH' });
      expect(auditActions()).toContain('UNKNOWN_CARTON');
    });
  });

  // ============================ SESSION PAYLOAD ============================
  describe('sessionDetail (expected card data for device-side matching)', () => {
    it('exposes independent productCards and cartonCards (all shipments, with tracking)', async () => {
      // A second shipment with its own tracking + carton (multi-shipment arrival).
      const arrival = baseArrival();
      arrival.shipments.push({
        ...baseArrival().shipments[0],
        id: 's-2', code: 'SHP-2', externalShipmentId: 'EXT-SHP-2', trackingNumber: 'TRK-2',
        cartons: [{
          id: 'c-3', externalCartonId: 'CTN-3', cartonReference: 'REF-CTN-3',
          qrCodeValue: 'QR-CTN-3', barcodeValue: 'BC-CTN-3', cartonNumber: 1, totalCartons: 1,
          status: 'EXPECTED', weight: null, weightUnit: null,
          length: null, width: null, height: null, dimensionUnit: null,
        }],
      });
      const sessionRow = fullSession();
      sessionRow.expectedArrival = arrival;
      sessionRow.products = [
        {
          id: 'p-1', sku: 'SKU-1', reference: 'REF-1', productName: 'Jewelry box',
          category: 'ACCESSORIES', subcategory: null, categoryStatus: 'CONFIRMED',
          expectedQuantity: 2, receivedQuantity: 1, difference: -1, status: 'PARTIALLY_RECEIVED',
        },
      ];
      db.receivingSession.findUnique.mockResolvedValue(sessionRow);
      db.expectedArrival.findUnique.mockResolvedValue(arrival);

      const res: any = await service.sessionDetail('sess-1');

      // PRODUCT cards: identifiers pre-normalized for device-side matching
      expect(res.productCards).toHaveLength(1);
      expect(res.productCards[0]).toMatchObject({
        sku: 'SKU-1', reference: 'REF-1', expected: 2, received: 1, remaining: 1,
        identifiers: ['SKU-1', 'REF-1'],
      });
      // CARTON cards: ALL shipments (3 total), each carrying its tracking
      expect(res.cartonCards).toHaveLength(3);
      expect(res.cartonCards[0]).toMatchObject({
        externalCartonId: 'CTN-1', trackingNumber: 'TRK-1', senderName: 'Sender Co',
        // card identity identifiers + the shipment tracking/suivi codes that
        // the floor may also scan to open a carton card
        identifiers: ['CTN-1', 'REF-CTN-1', 'QR-CTN-1', 'BC-CTN-1', 'TRK-1'],
      });
      expect(res.cartonCards[2]).toMatchObject({ externalCartonId: 'CTN-3', trackingNumber: 'TRK-2' });
      // the two card sets stay separate fields — never merged
      expect(res).toHaveProperty('productCards');
      expect(res).toHaveProperty('cartonCards');
      expect(res).not.toHaveProperty('mergedCards');
    });
  });

  // ============================ COMPLETE ============================
  describe('complete (duplicate completion protection)', () => {
    it('rejects completing an already-changed session (duplicate completion)', async () => {
      // Clean tally (no open discrepancies) so the guard reaches the state transition.
      db.receivingCarton.count.mockResolvedValue(2); // 2 of 2 cartons received
      db.receivingProduct.findMany.mockResolvedValue([]);
      db.receivingDiscrepancy.count.mockResolvedValue(0);
      // The session was concurrently changed -> updateMany matches 0 rows.
      db.receivingSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.complete('sess-1', ACTOR)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
