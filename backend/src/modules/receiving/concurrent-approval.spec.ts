import { ReceivingService } from './receiving.service';

/**
 * TEST J — two workers approve the SAME product unit at the same time.
 *
 * Shared receiving means concurrent scans are normal, not exceptional. The
 * confirm path computes `received = line.receivedQuantity + qty` from a read
 * taken outside the write transaction, so it is guarded by that same value
 * (optimistic concurrency). The loser of the race must NOT overwrite the
 * winner's receipt.
 */
function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  });
  return {
    receivingSession: model(), expectedArrival: model(), receivingProduct: model(),
    receivingScanEvent: model(), receivingCarton: model(), receivingDiscrepancy: model(),
    receivingWorkerLog: model(), warehouseCarton: model(), warehouseShipment: model(),
    workerTaskAssignment: model(), station: model(), user: model(), auditLog: model(),
  };
}
const ACTOR: any = { id: 'w-1', name: 'W', ip: null };

function build() {
  const db = prisma();
  db.$transaction = jest.fn((a: any) => a(db));
  const svc = new ReceivingService(db, { log: jest.fn() } as any,
    { assertOperationalAccess: jest.fn(), receivingStarted: jest.fn() } as any,
    { onReceivingCompleted: jest.fn() } as any);
  // A confirmable open session on an EXPECTED arrival.
  db.receivingSession.findUnique.mockResolvedValue({
    id: 's-1', arrivalId: 'arr-1', status: 'RECEIVING', code: 'RCV-1',
    expectedArrival: { id: 'arr-1', code: 'WAR-1', status: 'EXPECTED', shipments: [] },
  });
  db.receivingWorkerLog.create.mockResolvedValue({ id: 'log-1' });
  jest.spyOn(svc as any, 'sessionDetail').mockImplementation(async (_id: any, opts: any) => ({ flash: opts?.flash }));
  return { svc, db };
}

describe('TEST J — concurrent approval of the same product', () => {
  it('the write is guarded by the quantity it was computed from', async () => {
    const { svc, db } = build();
    db.receivingProduct.findFirst.mockResolvedValue({
      id: 'p-1', sku: 'SKU-1', reference: null, receivedQuantity: 0, expectedQuantity: 2, status: 'EXPECTED',
    });
    await svc.confirmProduct('s-1', { identifier: 'SKU-1', quantity: 1 } as any, ACTOR);
    const call = db.receivingProduct.updateMany.mock.calls[0][0];
    // Guard clause present: only applies while the row still reads 0.
    expect(call.where).toEqual({ id: 'p-1', receivedQuantity: 0 });
    expect(call.data.receivedQuantity).toBe(1);
  });

  it('the loser of the race does NOT overwrite the winner and re-runs on fresh state', async () => {
    const { svc, db } = build();
    // First read sees 0. By the time we write, another worker already wrote 1,
    // so the guarded update matches nothing (count: 0).
    db.receivingProduct.findFirst
      .mockResolvedValueOnce({ id: 'p-1', sku: 'SKU-1', reference: null, receivedQuantity: 0, expectedQuantity: 2, status: 'EXPECTED' })
      .mockResolvedValueOnce({ id: 'p-1', sku: 'SKU-1', reference: null, receivedQuantity: 1, expectedQuantity: 2, status: 'PARTIALLY_RECEIVED' });
    db.receivingProduct.updateMany
      .mockResolvedValueOnce({ count: 0 })   // lost the race
      .mockResolvedValueOnce({ count: 1 });  // retry succeeds

    const res: any = await svc.confirmProduct('s-1', { identifier: 'SKU-1', quantity: 1 } as any, ACTOR);

    // Retry was based on the winner's value (1), producing 2 — never 1 twice.
    const retry = db.receivingProduct.updateMany.mock.calls[1][0];
    expect(retry.where).toEqual({ id: 'p-1', receivedQuantity: 1 });
    expect(retry.data.receivedQuantity).toBe(2);
    expect(res.flash.kind).toBe('MATCH');
  });

  it('a fully received card is reported complete instead of over-counted', async () => {
    const { svc, db } = build();
    db.receivingProduct.findFirst.mockResolvedValue({
      id: 'p-1', sku: 'SKU-1', reference: null, receivedQuantity: 2, expectedQuantity: 2, status: 'RECEIVED',
    });
    const res: any = await svc.confirmProduct('s-1', { identifier: 'SKU-1', quantity: 1 } as any, ACTOR);
    expect(res.flash.kind).toBe('CARD_ALREADY_COMPLETE');
    expect(db.receivingProduct.updateMany).not.toHaveBeenCalled();
  });

  it('an operationId replay is applied exactly once (idempotent)', async () => {
    const { svc, db } = build();
    db.receivingScanEvent.findUnique.mockResolvedValue({ id: 'e-1', sessionId: 's-1', operationId: 'op-1' });
    await svc.confirmProduct('s-1', { identifier: 'SKU-1', quantity: 1, operationId: 'op-1' } as any, ACTOR);
    // Replay short-circuits before any write.
    expect(db.receivingProduct.updateMany).not.toHaveBeenCalled();
  });

  it('every approval is written to the audit trail with the acting worker', async () => {
    const { svc, db } = build();
    db.receivingProduct.findFirst.mockResolvedValue({
      id: 'p-1', sku: 'SKU-1', reference: null, receivedQuantity: 0, expectedQuantity: 2, status: 'EXPECTED',
    });
    const audit = jest.fn();
    (svc as any).audit = { log: audit };
    await svc.confirmProduct('s-1', { identifier: 'SKU-1', quantity: 1 } as any, ACTOR);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'w-1', action: 'PRODUCT_RECEIVED', entityId: 'p-1' }),
      expect.anything(),
    );
  });
});
