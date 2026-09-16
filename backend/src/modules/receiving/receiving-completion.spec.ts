import { ReceivingService } from './receiving.service';

/**
 * R1 FIX (owner order 2026-09-13) — the shared RECEIVING completion write.
 *
 * Before this fix NOTHING in the product could complete a receiving session:
 * the report submit (CONFIRMER ET ENVOYER) locked the report and handed the
 * stock off, but the session stayed RECEIVING forever (live proof:
 * RCV-000201 / WAR-001002 stuck since 2026-09-11). The completion logic is
 * now ONE shared, audited, guarded write used by the worker complete
 * endpoint, the report submit and the operations recovery endpoint:
 *   clean tally  → COMPLETED + arrival RECEIVED
 *   discrepancies→ COMPLETED_WITH_DISCREPANCY + arrival RECEIVED_WITH_… +
 *                  SHORT line marking
 *   lost race    → applied:false, NOTHING written (never completed twice)
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

const CLEAN_TALLY = {
  openDiscrepancies: 0, shortUnits: 0, overageUnits: 0, unexpectedProducts: 0, missingCartons: 0,
  expectedUnits: 5, receivedUnits: 5, expectedCartons: 2, receivedCartons: 2,
  expectedProducts: 2, receivedProducts: 2,
};
const SHORT_TALLY = { ...CLEAN_TALLY, shortUnits: 2 };
const SESSION = { id: 'sess-1', code: 'RCV-000201', status: 'RECEIVING', arrivalId: 'arr-1', stationId: null };

describe('Receiving completion (R1 — the shared completion write)', () => {
  let service: ReceivingService;
  let db: any;
  let audit: { log: jest.Mock };
  let assignments: any;
  let dispatch: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((action: any) => action(db));
    audit = { log: jest.fn() };
    assignments = { assertOperationalAccess: jest.fn(), receivingCompleted: jest.fn() };
    dispatch = { onReceivingCompleted: jest.fn().mockResolvedValue({ created: [] }) };
    service = new ReceivingService(db, audit as never, assignments as never, dispatch as never, {} as never, { emit: jest.fn() } as never);
  });

  it('clean tally → session COMPLETED + arrival RECEIVED + audit + assignment closure; no SHORT marking', async () => {
    const res = await service.applyCompletionTx(db, SESSION, CLEAN_TALLY, { id: 'w-1', ip: '10.0.0.9' }, 'RECEIVING');
    expect(res).toMatchObject({ finalStatus: 'COMPLETED', arrivalStatus: 'RECEIVED', applied: true });
    const call = db.receivingSession.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'sess-1', status: 'RECEIVING' });
    expect(call.data).toMatchObject({ status: 'COMPLETED', completedBy: 'w-1' });
    expect(db.expectedArrival.update.mock.calls[0][0]).toEqual({ where: { id: 'arr-1' }, data: { status: 'RECEIVED' } });
    expect(db.receivingProduct.updateMany).not.toHaveBeenCalled();
    expect(audit.log.mock.calls[0][0].action).toBe('RECEIVING_COMPLETED');
    expect(assignments.receivingCompleted).toHaveBeenCalledWith('arr-1', false, 'RCV-000201', 'w-1', db);
  });

  it('discrepancy tally → COMPLETED_WITH_DISCREPANCY + RECEIVED_WITH_DISCREPANCY + SHORT marking', async () => {
    const res = await service.applyCompletionTx(db, SESSION, SHORT_TALLY, { id: 'w-1' }, 'RECEIVING');
    expect(res).toMatchObject({ finalStatus: 'COMPLETED_WITH_DISCREPANCY', arrivalStatus: 'RECEIVED_WITH_DISCREPANCY', applied: true });
    expect(db.receivingProduct.updateMany).toHaveBeenCalledWith({
      where: { receivingSessionId: 'sess-1', status: { in: ['EXPECTED', 'PARTIALLY_RECEIVED'] } },
      data: { status: 'SHORT' },
    });
    expect(audit.log.mock.calls[0][0].action).toBe('RECEIVING_COMPLETED_WITH_DISCREPANCY');
    expect(assignments.receivingCompleted).toHaveBeenCalledWith('arr-1', true, 'RCV-000201', 'w-1', db);
  });

  it('a lost race (session no longer RECEIVING) writes NOTHING and answers applied:false', async () => {
    db.receivingSession.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await service.applyCompletionTx(db, SESSION, CLEAN_TALLY, { id: 'w-1' }, 'RECEIVING');
    expect(res.applied).toBe(false);
    expect(db.expectedArrival.update).not.toHaveBeenCalled();
    expect(db.receivingProduct.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(assignments.receivingCompleted).not.toHaveBeenCalled();
  });

  it('fireReceivingCompletedTasks: §9 dispatch fires with the session identity; unknown session is a null no-op', async () => {
    db.receivingSession.findUnique.mockResolvedValue({ id: 'sess-1', code: 'RCV-000201', arrivalId: 'arr-1' });
    await service.fireReceivingCompletedTasks('sess-1', 'w-1', 'report submit');
    expect(dispatch.onReceivingCompleted).toHaveBeenCalledWith(
      { id: 'sess-1', code: 'RCV-000201', arrivalId: 'arr-1' }, 'w-1', { reason: 'report submit' },
    );
    db.receivingSession.findUnique.mockResolvedValueOnce(null);
    await expect(service.fireReceivingCompletedTasks('ghost', 'w-1', 'x')).resolves.toBeNull();
    expect(dispatch.onReceivingCompleted).toHaveBeenCalledTimes(1);
  });
});
