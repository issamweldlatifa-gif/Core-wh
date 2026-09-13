import { ReceivingService } from './receiving.service';

/**
 * OWNER ORDER 2026-09-13 — batch cards ARE received at the RECEIVING station.
 *
 * The admin dispatches a batch (batch → admin → receiving, automatic). The
 * RECEIVING home feed must therefore surface the batch as a PRODUCT card
 * whose identifiers are its AYP unit codes, and a scanned unit code must be
 * received through the batches service's own audited logic (start → ONE
 * scan = ONE unit → auto-complete at n/n) with the device's existing flash
 * vocabulary. The parcel label (batch code) must NEVER count a unit.
 */

function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn(),
  });
  return {
    receivingSession: model(), expectedArrival: model(), expectedArrivalItem: model(), receivingProduct: model(),
    receivingScanEvent: model(), receivingCarton: model(), receivingDiscrepancy: model(),
    receivingWorkerLog: model(), warehouseCarton: model(), warehouseShipment: model(),
    station: model(), user: model(), auditLog: model(),
    batch: model(), batchItem: model(), ayroviUnit: model(),
  };
}

const ACTOR = { id: 'w-1', name: 'Issam', canResolveDiscrepancy: false, ip: '10.0.0.1', permissions: ['receiving.execute', 'batch.receive'] };

function batchRow() {
  return {
    id: 'b1', batchCode: 'AYB-20260913-00007', status: 'SENT_TO_RECEIVING',
    totalExpected: 2, totalScanned: 0, sentAt: new Date(),
    items: [
      { unit: { code: 'AYP-000000042' } },
      { unit: { code: 'AYP-000000043' } },
    ],
  };
}

describe('Receiving home × batches (the admin-dispatched cards are received in RECEIVING)', () => {
  let service: ReceivingService;
  let db: any;
  let audit: { log: jest.Mock };
  let assignments: any;
  let dispatch: any;
  let batches: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((action: any) => action(db));
    audit = { log: jest.fn() };
    assignments = { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn(), receivingCompleted: jest.fn() };
    dispatch = { onReceivingCompleted: jest.fn().mockResolvedValue({ created: [] }) };
    batches = {
      startReceiving: jest.fn().mockResolvedValue({ batch: { status: 'RECEIVING_IN_PROGRESS' } }),
      receiveUnit: jest.fn().mockResolvedValue({ unitCode: 'AYP-000000042', alreadyReceived: false, totalScanned: 1, totalExpected: 2 }),
      completeReceiving: jest.fn().mockResolvedValue({ batch: { status: 'RECEIVING_COMPLETED' } }),
    };
    service = new ReceivingService(db, audit as never, assignments as never, dispatch as never, batches as never);
  });

  it('workerHome merges the dispatched batches as PRODUCT cards keyed by their AYP unit codes', async () => {
    db.batch.findMany.mockResolvedValue([batchRow()]);
    const home: any = await service.workerHome('w-1', ACTOR);
    expect(db.batch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ['SENT_TO_RECEIVING', 'RECEIVING_IN_PROGRESS'] } },
    }));
    const card = home.productCards.find((c: any) => c.id === 'batch-unit-b1');
    expect(card).toBeDefined();
    expect(card.identifiers).toEqual(['AYP-000000042', 'AYP-000000043']);
    expect(card).toMatchObject({ expected: 2, received: 0, remaining: 2, status: 'SENT_TO_RECEIVING' });
    // The batch CODE is deliberately NOT a model field — scanning the parcel
    // label must never count a unit.
    expect(card.sku).toBeNull();
    expect(card.reference).toBeNull();
  });

  it('a fully received batch disappears from the feed', async () => {
    db.batch.findMany.mockResolvedValue([{ ...batchRow(), totalScanned: 2 }]);
    const home: any = await service.workerHome('w-1', ACTOR);
    expect(home.productCards.find((c: any) => c.id === 'batch-unit-b1')).toBeUndefined();
  });

  it('a scanned unit code with no matching arrival is received through the batches logic (start → scan)', async () => {
    db.batch.findMany.mockResolvedValue([]);
    db.expectedArrival.findMany.mockResolvedValue([]);
    db.ayroviUnit.findUnique.mockResolvedValue({
      code: 'AYP-000000042',
      batchItems: [{ batch: { id: 'b1', batchCode: 'AYB-20260913-00007', status: 'SENT_TO_RECEIVING' } }],
    });
    const res: any = await service.homeConfirmProduct(
      { identifier: 'ayp-000000042', identifierType: 'BARCODE', quantity: 1, operationId: 'op-1', source: 'IMAGER' } as never, ACTOR,
    );
    expect(batches.startReceiving).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }), 'b1');
    expect(batches.receiveUnit).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }), 'b1', { unitCode: 'AYP-000000042' });
    expect(batches.completeReceiving).not.toHaveBeenCalled();
    expect(res.flash.kind).toBe('MATCH');
    expect(res.flash.message).toContain('AYB-20260913-00007 · 1/2');
  });

  it('the LAST unit auto-completes the batch with a deterministic idempotency key', async () => {
    db.batch.findMany.mockResolvedValue([]);
    db.expectedArrival.findMany.mockResolvedValue([]);
    db.ayroviUnit.findUnique.mockResolvedValue({
      code: 'AYP-000000043',
      batchItems: [{ batch: { id: 'b1', batchCode: 'AYB-20260913-00007', status: 'RECEIVING_IN_PROGRESS' } }],
    });
    batches.receiveUnit.mockResolvedValue({ unitCode: 'AYP-000000043', alreadyReceived: false, totalScanned: 2, totalExpected: 2 });
    const res: any = await service.homeConfirmProduct(
      { identifier: 'AYP-000000043', identifierType: 'BARCODE', quantity: 1, operationId: 'op-2', source: 'IMAGER' } as never, ACTOR,
    );
    expect(batches.startReceiving).not.toHaveBeenCalled(); // already IN_PROGRESS
    expect(batches.completeReceiving).toHaveBeenCalledWith(expect.anything(), 'b1', { idempotencyKey: 'auto-complete:b1' });
    expect(res.flash.message).toContain('COMPLETE · 2/2');
  });

  it('a repeated label answers the already-received warning through the SAME flash the device renders', async () => {
    db.batch.findMany.mockResolvedValue([]);
    db.expectedArrival.findMany.mockResolvedValue([]);
    db.ayroviUnit.findUnique.mockResolvedValue({
      code: 'AYP-000000042',
      batchItems: [{ batch: { id: 'b1', batchCode: 'AYB-20260913-00007', status: 'RECEIVING_IN_PROGRESS' } }],
    });
    batches.receiveUnit.mockResolvedValue({ unitCode: 'AYP-000000042', alreadyReceived: true, totalScanned: 1, totalExpected: 2 });
    const res: any = await service.homeConfirmProduct(
      { identifier: 'AYP-000000042', identifierType: 'BARCODE', quantity: 1, operationId: 'op-3', source: 'IMAGER' } as never, ACTOR,
    );
    expect(res.flash.kind).toBe('UNIT_ALREADY_SCANNED');
    expect(res.ok).toBe(true);
  });

  it('INCIDENT (ST-REC-01 screenshot): a receiving worker WITHOUT batch.receive receives batch units — receiving.execute is the only gate', async () => {
    db.batch.findMany.mockResolvedValue([]);
    db.expectedArrival.findMany.mockResolvedValue([]);
    db.ayroviUnit.findUnique.mockResolvedValue({
      code: 'AYP-000000042',
      batchItems: [{ batch: { id: 'b1', batchCode: 'AYB-20260913-00007', status: 'SENT_TO_RECEIVING' } }],
    });
    const res: any = await service.homeConfirmProduct(
      { identifier: 'AYP-000000042', identifierType: 'BARCODE', quantity: 1, operationId: 'op-4', source: 'IMAGER' } as never,
      { ...ACTOR, permissions: ['receiving.execute'] },
    );
    expect(batches.startReceiving).toHaveBeenCalled();
    expect(batches.receiveUnit).toHaveBeenCalled();
    expect(res.flash.kind).toBe('MATCH');
  });

  it('an unknown code (no arrival, no batch) keeps the classic MISMATCH path', async () => {
    db.batch.findMany.mockResolvedValue([]);
    db.expectedArrival.findMany.mockResolvedValue([]);
    db.ayroviUnit.findUnique.mockResolvedValue(null);
    const res: any = await service.homeConfirmProduct(
      { identifier: 'UNKNOWN-CODE', identifierType: 'BARCODE', quantity: 1, operationId: 'op-5', source: 'IMAGER' } as never, ACTOR,
    );
    expect(res.flash.kind).toBe('MISMATCH');
    expect(batches.receiveUnit).not.toHaveBeenCalled();
  });
});
