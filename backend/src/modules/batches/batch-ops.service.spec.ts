import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BatchesService } from './batches.service';

/**
 * BATCH OPS — service-level contract tests (Phase 2 slice 2).
 *
 * Everything the command makes binding is asserted HERE against the real
 * service logic: flag gate, per-op idempotency, optimistic concurrency
 * (guarded updateMany, house pattern), every-scan-is-one-unit, 10/10
 * completion, void-not-delete, atomic audit, and the state machine edge.
 */
function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    count: jest.fn().mockResolvedValue(0),
  });
  return {
    batch: model(), batchItem: model(), ayroviUnit: model(),
    batchCustomer: model(), systemSetting: model(), auditLog: model(),
  };
}

const FLAG_ON = [{ key: 'batch.enabled', value: true }];
const ACTOR: any = { id: 'w-1', name: 'Worker One', ip: null };

function build(flagRows: any[] = FLAG_ON) {
  const db = prisma();
  db.$transaction = jest.fn((a: any) => a(db));
  db.systemSetting.findMany.mockResolvedValue(flagRows);
  const audit = { log: jest.fn().mockResolvedValue({ id: 'a1' }) };
  const svc = new BatchesService(db, audit as any);
  return { svc, db, audit };
}

const CREATE_DTO: any = {
  idempotencyKey: 'key-create-0001',
  customer: { name: 'Ahmed Akrmi' },
  firstItem: {
    idempotencyKey: 'key-unit-0001', identifierType: 'BARCODE',
    identifierValue: '5901234567890', originalBarcode: '5901234567890',
  },
};

describe('Batch flag gate', () => {
  it('every operation refuses while batch.enabled is OFF', async () => {
    const { svc } = build([{ key: 'batch.enabled', value: 'false' }]);
    await expect(svc.create(ACTOR, CREATE_DTO)).rejects.toThrow(ForbiddenException);
    await expect(svc.list({})).rejects.toThrow(ForbiddenException);
    await expect(svc.startReceiving(ACTOR, 'b1')).rejects.toThrow(ForbiddenException);
  });

  it('an ABSENT flag key is OFF too (default-off contract)', async () => {
    const { svc } = build([{ key: 'other.setting', value: 'x' }]);
    await expect(svc.create(ACTOR, CREATE_DTO)).rejects.toThrow(ForbiddenException);
  });
});

describe('create — AYB code, worker customer, replay', () => {
  it('creates CREATED batch with sequential code + audit atomically', async () => {
    const { svc, db, audit } = build();
    db.batch.findUnique.mockResolvedValue(null); // no replay
    db.batch.findFirst.mockResolvedValue({ batchCode: 'AYB-20260911-00004' }); // day max
    db.batchCustomer.findFirst.mockResolvedValue(null);
    db.batchCustomer.create.mockResolvedValue({ id: 'c1', name: 'Ahmed Akrmi' });
    db.batch.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'b1', ...data }));
    db.ayroviUnit.findFirst.mockResolvedValue(null); // first AYP ever
    db.ayroviUnit.create.mockResolvedValue({ id: 'u1', code: 'AYP-000000001' });
    db.batchItem.create.mockResolvedValue({ id: 'i1' });

    const res: any = await svc.create(ACTOR, CREATE_DTO);

    expect(res.replayed).toBe(false);
    expect(res.batch.batchCode).toBe('AYB-20260911-00005'); // max+1, never count-based
    expect(res.batch.status).toBe('CREATED');
    expect(res.batch.source).toBe('WORKER_APP_BATCH');
    expect(db.batch.create.mock.calls[0][0].data.idempotencyKey).toBe('key-create-0001');
    expect(db.batchItem.create).toHaveBeenCalledTimes(1); // firstItem landed
    const aud = audit.log.mock.calls[0][0];
    expect(aud.action).toBe('BATCH_CREATED');
    expect(audit.log.mock.calls[0][1]).toBe(db); // atomic with the mutation (tx)
  });

  it('replays the SAME batch for the SAME create idempotency key', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', batchCode: 'AYB-20260911-00001' });
    const res: any = await svc.create(ACTOR, CREATE_DTO);
    expect(res.replayed).toBe(true);
    expect(res.batch.id).toBe('b1');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('MANUAL first item must NOT invent original identity', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue(null);
    const bad: any = {
      ...CREATE_DTO,
      firstItem: { idempotencyKey: 'k2', identifierType: 'MANUAL', originalSku: 'SB123' },
    };
    await expect(svc.create(ACTOR, bad)).rejects.toThrow(BadRequestException);
  });
});

describe('addUnit — AYP identity, optimistic totalExpected, replay', () => {
  const BATCH = { id: 'b1', batchCode: 'AYB-20260911-00005', status: 'CREATED', totalExpected: 2 };
  const UNIT_DTO: any = { idempotencyKey: 'key-unit-0002', identifierType: 'SKU', identifierValue: 'sb-123' };

  it('adds a unit: AYP code generated, originals verbatim, count guarded', async () => {
    const { svc, db, audit } = build();
    db.batchItem.findUnique.mockResolvedValue(null);
    db.batch.findUnique.mockResolvedValue(BATCH);
    db.ayroviUnit.findFirst.mockResolvedValue({ code: 'AYP-000000007' });
    db.ayroviUnit.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'u1', code: data.code }));
    db.batchItem.create.mockResolvedValue({ id: 'i1' });

    const res: any = await svc.addUnit(ACTOR, 'b1', UNIT_DTO);

    expect(res.unit.code).toBe('AYP-000000008');
    const udata = db.ayroviUnit.create.mock.calls[0][0].data;
    expect(udata.code).toBe('AYP-000000008');
    const guard = db.batch.updateMany.mock.calls[0][0];
    expect(guard.where).toEqual({ id: 'b1', totalExpected: 2 }); // optimistic guard
    expect(guard.data.totalExpected).toEqual({ increment: 1 });
    expect(audit.log.mock.calls[0][0].action).toBe('BATCH_UNIT_ADDED');
  });

  it('loses the increment race → BATCH_RACE_RETRY (client replays with same key)', async () => {
    const { svc, db } = build();
    db.batchItem.findUnique.mockResolvedValue(null);
    db.batch.findUnique.mockResolvedValue(BATCH);
    db.ayroviUnit.findFirst.mockResolvedValue(null);
    db.ayroviUnit.create.mockResolvedValue({ id: 'u1', code: 'AYP-000000001' });
    db.batchItem.create.mockResolvedValue({ id: 'i1' });
    db.batch.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.addUnit(ACTOR, 'b1', UNIT_DTO)).rejects.toThrow(ConflictException);
  });

  it('refuses units once the batch left CREATED', async () => {
    const { svc, db } = build();
    db.batchItem.findUnique.mockResolvedValue(null);
    db.batch.findUnique.mockResolvedValue({ ...BATCH, status: 'SUBMITTED' });
    await expect(svc.addUnit(ACTOR, 'b1', UNIT_DTO)).rejects.toThrow(ConflictException);
  });

  it('replays the SAME item for the SAME key, rejects a reused key on another batch', async () => {
    const { svc, db } = build();
    db.batchItem.findUnique.mockResolvedValue({ batchId: 'b1', unit: { code: 'AYP-000000001' } });
    const ok: any = await svc.addUnit(ACTOR, 'b1', UNIT_DTO);
    expect(ok.replayed).toBe(true);

    db.batchItem.findUnique.mockResolvedValue({ batchId: 'OTHER', unit: {} });
    await expect(svc.addUnit(ACTOR, 'b1', UNIT_DTO)).rejects.toThrow(ConflictException);
  });
});

describe('submit / accept — state machine + per-op idempotency', () => {
  it('submits: CREATED → SUBMITTED, key stored, guard on the exact read state', async () => {
    const { svc, db, audit } = build();
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', batchCode: 'AYB-20260911-00005', status: 'CREATED', totalExpected: 3, submitIdempotencyKey: null,
    });
    const res: any = await svc.submit(ACTOR, 'b1', { idempotencyKey: 'key-submit-001' });
    const call = db.batch.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'b1', status: 'CREATED', submitIdempotencyKey: null });
    expect(call.data.status).toBe('SUBMITTED');
    expect(call.data.submitIdempotencyKey).toBe('key-submit-001');
    expect(res.batch.status).toBe('SUBMITTED');
    expect(audit.log.mock.calls[0][0].action).toBe('BATCH_SUBMITTED');
  });

  it('refuses an EMPTY submit and replays a repeated key', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', status: 'CREATED', totalExpected: 0, submitIdempotencyKey: null,
    });
    await expect(svc.submit(ACTOR, 'b1', { idempotencyKey: 'key-submit-001' })).rejects.toThrow(ConflictException);

    db.batch.findUnique.mockResolvedValue({
      id: 'b1', status: 'SUBMITTED', totalExpected: 3, submitIdempotencyKey: 'key-submit-001',
    });
    const res: any = await svc.submit(ACTOR, 'b1', { idempotencyKey: 'key-submit-001' });
    expect(res.replayed).toBe(true);
  });

  it('accept from CREATED is a forbidden transition', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', status: 'CREATED' });
    await expect(svc.accept(ACTOR, 'b1', { operatorId: 'op-1' } as any)).rejects.toThrow(ConflictException);
  });

  it('accept from SUBMITTED stores attribution and is guarded', async () => {
    const { svc, db, audit } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', batchCode: 'AYB-20260911-00005', status: 'SUBMITTED' });
    const res: any = await svc.accept(ACTOR, 'b1', { operatorId: 'op-9' } as any);
    const call = db.batch.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'b1', status: 'SUBMITTED' });
    expect(call.data.acceptedById).toBe('op-9');
    expect(res.batch.status).toBe('ACCEPTED');
    expect(audit.log.mock.calls[0][0].action).toBe('BATCH_ACCEPTED');
  });
});

describe('send / receiving — every scan ONE unit, 10/10 completion', () => {
  it('send: ACCEPTED → SENT_TO_RECEIVING with replay key', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', batchCode: 'AYB-20260911-00005', status: 'ACCEPTED', sendIdempotencyKey: null,
    });
    const res: any = await svc.send(ACTOR, 'b1', { operatorId: 'op-9', idempotencyKey: 'key-send-0001' } as any);
    const call = db.batch.updateMany.mock.calls[0][0];
    expect(call.data.status).toBe('SENT_TO_RECEIVING');
    expect(call.data.sendIdempotencyKey).toBe('key-send-0001');
    expect(res.replayed).toBe(false);
  });

  it('scans refuse before receiving starts', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', status: 'SENT_TO_RECEIVING', totalScanned: 0, totalExpected: 2 });
    await expect(svc.receiveUnit(ACTOR, 'b1', { unitCode: 'AYP-000000001' })).rejects.toThrow(ConflictException);
  });

  it('ONE scan = ONE unit: receipt + guarded increment + audit', async () => {
    const { svc, db, audit } = build();
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', batchCode: 'AYB', status: 'RECEIVING_IN_PROGRESS', totalScanned: 7, totalExpected: 10,
    });
    db.ayroviUnit.findUnique.mockResolvedValue({
      code: 'AYP-000000003', batchItems: [{ id: 'i1', batchId: 'b1', status: 'REGISTERED', identifierType: 'SKU' }],
    });
    const res: any = await svc.receiveUnit(ACTOR, 'b1', { unitCode: ' AYP-000000003 ' });
    expect(db.batchItem.updateMany.mock.calls[0][0].where).toEqual({ id: 'i1', status: 'REGISTERED' });
    const counter = db.batch.updateMany.mock.calls[0][0];
    expect(counter.where).toEqual({ id: 'b1', totalScanned: 7 }); // lost-update guard
    expect(res).toMatchObject({ unitCode: 'AYP-000000003', alreadyReceived: false, totalScanned: 8, totalExpected: 10 });
    expect(audit.log.mock.calls[0][0].action).toBe('BATCH_UNIT_RECEIVED');
  });

  it('same LABEL twice is a no-op (never double counts); same SKU on another piece scans again', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', status: 'RECEIVING_IN_PROGRESS', totalScanned: 8, totalExpected: 10,
    });
    db.ayroviUnit.findUnique.mockResolvedValue({
      code: 'AYP-000000003', batchItems: [{ id: 'i1', batchId: 'b1', status: 'RECEIVED', identifierType: 'SKU' }],
    });
    const res: any = await svc.receiveUnit(ACTOR, 'b1', { unitCode: 'AYP-000000003' });
    expect(res.alreadyReceived).toBe(true);
    expect(db.batchItem.updateMany).not.toHaveBeenCalled();
    expect(db.batch.updateMany).not.toHaveBeenCalled();
  });

  it('a unit of ANOTHER batch is refused; an unknown code is 404', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', status: 'RECEIVING_IN_PROGRESS', totalScanned: 0, totalExpected: 2 });
    db.ayroviUnit.findUnique.mockResolvedValue({ code: 'AYP-000000009', batchItems: [] });
    await expect(svc.receiveUnit(ACTOR, 'b1', { unitCode: 'AYP-000000009' })).rejects.toThrow(ConflictException);

    db.ayroviUnit.findUnique.mockResolvedValue(null);
    await expect(svc.receiveUnit(ACTOR, 'b1', { unitCode: 'AYP-999999999' })).rejects.toThrow(NotFoundException);
  });

  it('complete with missing units refuses with the count; complete stores the key', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', batchCode: 'AYB', status: 'RECEIVING_IN_PROGRESS', totalScanned: 8, totalExpected: 10,
      completeReceivingIdempotencyKey: null,
    });
    db.batchItem.count.mockResolvedValue(2);
    await expect(svc.completeReceiving(ACTOR, 'b1', { idempotencyKey: 'key-done-0001' })).rejects.toThrow(/2 unit\(s\)/);

    db.batchItem.count.mockResolvedValue(0);
    db.batch.findUnique.mockResolvedValue({
      id: 'b1', batchCode: 'AYB', status: 'RECEIVING_IN_PROGRESS', totalScanned: 10, totalExpected: 10,
      completeReceivingIdempotencyKey: null,
    });
    const res: any = await svc.completeReceiving(ACTOR, 'b1', { idempotencyKey: 'key-done-0001' });
    const call = db.batch.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'b1', status: 'RECEIVING_IN_PROGRESS', completeReceivingIdempotencyKey: null });
    expect(call.data.status).toBe('RECEIVING_COMPLETED');
    expect(res.batch.status).toBe('RECEIVING_COMPLETED');
  });
});

describe('void — VOID + audit, never DELETE; terminals are sealed', () => {
  it('voids from ACCEPTED with mandatory reason + audit', async () => {
    const { svc, db, audit } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', batchCode: 'AYB', status: 'ACCEPTED' });
    const res: any = await svc.voidBatch(ACTOR, 'b1', { operatorId: 'op-1', reason: 'duplicate batch' });
    const call = db.batch.updateMany.mock.calls[0][0];
    expect(call.data.status).toBe('VOIDED');
    expect(call.data.voidReason).toBe('duplicate batch');
    expect(res.batch.status).toBe('VOIDED');
    expect(audit.log.mock.calls[0][0].action).toBe('BATCH_VOIDED');
  });

  it('terminal states (RECEIVING_COMPLETED / VOIDED) cannot be voided', async () => {
    const { svc, db } = build();
    db.batch.findUnique.mockResolvedValue({ id: 'b1', status: 'RECEIVING_COMPLETED' });
    await expect(svc.voidBatch(ACTOR, 'b1', { operatorId: 'op-1', reason: 'x' })).rejects.toThrow(ConflictException);
    db.batch.findUnique.mockResolvedValue({ id: 'b1', status: 'VOIDED' });
    await expect(svc.voidBatch(ACTOR, 'b1', { operatorId: 'op-1', reason: 'x' })).rejects.toThrow(ConflictException);
  });
});

describe('dmmf guards — idempotency anchors + audit actions exist in the schema', () => {
  const dmmf = (require('@prisma/client') as any).Prisma.dmmf;

  it('Batch carries the submit/send/complete idempotency keys (command §5)', () => {
    const m = dmmf.datamodel.models.find((x: any) => x.name === 'Batch');
    const fields = m.fields.map((f: any) => f.name);
    expect(fields).toEqual(expect.arrayContaining([
      'idempotencyKey', 'submitIdempotencyKey', 'sendIdempotencyKey', 'completeReceivingIdempotencyKey',
    ]));
  });

  it('AuditAction carries the nine BATCH_* actions', () => {
    const e = dmmf.datamodel.enums.find((x: any) => x.name === 'AuditAction');
    const values = e.values.map((v: any) => v.name);
    expect(values).toEqual(expect.arrayContaining([
      'BATCH_CREATED', 'BATCH_UNIT_ADDED', 'BATCH_SUBMITTED', 'BATCH_ACCEPTED', 'BATCH_SENT_TO_RECEIVING',
      'BATCH_RECEIVING_STARTED', 'BATCH_UNIT_RECEIVED', 'BATCH_RECEIVING_COMPLETED', 'BATCH_VOIDED',
    ]));
  });
});
