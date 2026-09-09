import { ConflictException, NotFoundException } from '@nestjs/common';
import { TemporaryStorageService } from './temporary-storage.service';

/**
 * Temporary Storage — unit tests (mocked prisma, no DB).
 *
 * Covers the input contract:
 *   PRODUCT ONLY intake (Receiving Output B) · CONFIRMED-only handoff ·
 *   carton identifiers rejected by the workflow guard · idempotent re-push ·
 *   server-side STAGING station resolution · zone/location validation ·
 *   forward transitions RECEIVED -> STAGED -> READY_FOR_SORTING -> MOVED_TO_SORTING.
 */

function model() {
  return {
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn().mockResolvedValue(0),
  };
}

function txMock() {
  return { temporaryStorageIntake: model(), auditLog: model(), workflowEvent: model() };
}

function prismaMock(tx: any) {
  return {
    temporaryStorageIntake: model(),
    receivingSession: model(),
    receivingReport: model(),
    receivingProduct: model(),
    station: model(),
    zone: model(),
    location: model(),
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  } as any;
}

const ACTOR = { id: 'w-1', ip: '10.0.0.1' };

function service(db: { prisma: any; tx: any }, workflow?: any) {
  const audit = { log: jest.fn().mockResolvedValue({}) } as any;
  const assignments = { assertOperationalAccess: jest.fn().mockResolvedValue(undefined) } as any;
  const wf = workflow ?? { logEvent: jest.fn().mockResolvedValue({}), assertNotCartonIdentifier: jest.fn().mockResolvedValue(undefined) };
  return {
    svc: new TemporaryStorageService(db.prisma, audit, assignments, wf),
    audit, assignments, wf,
  };
}

const HANDOFF = {
  receivingSessionId: 'sess-1',
  receivingProductId: 'rp-1',
  receivingReportId: 'rep-1',
  receivingReportLineId: 'rl-1',
  sku: 'SKU-A',
  reference: 'REF-A',
  productName: 'Shirt',
  quantity: 5,
  verificationResult: 'CONFIRMED' as const,
};

describe('TemporaryStorageService', () => {
  test('createIntakeFromReceiving creates a PRODUCT intake + audit + handoff events', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc, audit, wf } = service(db);
    tx.temporaryStorageIntake.findFirst.mockResolvedValue(null);
    tx.temporaryStorageIntake.findUnique.mockResolvedValue(null);
    tx.temporaryStorageIntake.create.mockImplementation(async ({ data }: any) => ({ id: 'tmp-1', ...data }));

    const row = await svc.createIntakeFromReceiving(tx as any, HANDOFF, ACTOR);

    expect(row.code).toBe('TMP-000001');
    expect(row.status).toBe('RECEIVED');
    expect(row.sku).toBe('SKU-A');
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(wf.logEvent).toHaveBeenCalledTimes(2);
    const events = wf.logEvent.mock.calls.map((c: any[]) => c[0]);
    expect(events.map((e: any) => e.event)).toEqual(['PRODUCT_HANDOFF_TEMP', 'TEMP_STORAGE_RECEIVED']);
    expect(events.every((e: any) => e.flow === 'PRODUCT')).toBe(true);
  });

  test('createIntakeFromReceiving rejects non-CONFIRMED lines', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    await expect(
      svc.createIntakeFromReceiving(tx as any, { ...HANDOFF, verificationResult: 'MISSING' }, ACTOR),
    ).rejects.toThrow(ConflictException);
    expect(tx.temporaryStorageIntake.create).not.toHaveBeenCalled();
  });

  test('createIntakeFromReceiving is idempotent per report line', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    tx.temporaryStorageIntake.findFirst.mockResolvedValue({ id: 'tmp-9', code: 'TMP-000009' });
    const row = await svc.createIntakeFromReceiving(tx as any, HANDOFF, ACTOR);
    expect(row.code).toBe('TMP-000009');
    expect(tx.temporaryStorageIntake.create).not.toHaveBeenCalled();
  });

  test('createIntakeFromReceiving rejects carton identifiers (Output A never enters)', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const guard = new ConflictException('Carton flow ended at Receiving.');
    const { svc, wf } = service(db, {
      logEvent: jest.fn(),
      assertNotCartonIdentifier: jest.fn().mockRejectedValue(guard),
    });
    await expect(svc.createIntakeFromReceiving(tx as any, HANDOFF, ACTOR)).rejects.toThrow(ConflictException);
    expect(wf.assertNotCartonIdentifier).toHaveBeenCalled();
    expect(tx.temporaryStorageIntake.create).not.toHaveBeenCalled();
  });

  test('manualIntake requires a submitted report', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.receivingSession.findUnique.mockResolvedValue({ id: 'sess-1' });
    db.prisma.receivingReport.findUnique.mockResolvedValue({ id: 'rep-1', status: 'DRAFT', lines: [] });
    await expect(
      svc.manualIntake({ receivingSessionId: 'sess-1', receivingProductId: 'rp-1' }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  test('manualIntake requires a CONFIRMED line', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.receivingSession.findUnique.mockResolvedValue({ id: 'sess-1' });
    db.prisma.receivingReport.findUnique.mockResolvedValue({ id: 'rep-1', status: 'SUBMITTED', lines: [] });
    db.prisma.receivingProduct.findFirst.mockResolvedValue({
      id: 'rp-1', sku: 'SKU-A', reference: null, productName: 'Shirt',
      expectedQuantity: 5, receivedQuantity: 2, damagedQuantity: 0,
    });
    await expect(
      svc.manualIntake({ receivingSessionId: 'sess-1', receivingProductId: 'rp-1' }, ACTOR),
    ).rejects.toThrow(ConflictException);
  });

  test('stageIntake stages at the worker STAGING station with its zone', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    const intake = { id: 'tmp-1', code: 'TMP-000001', status: 'RECEIVED', receivingSessionId: 'sess-1' };
    db.prisma.temporaryStorageIntake.findUnique.mockResolvedValue(intake);
    db.prisma.station.findFirst.mockResolvedValue({
      id: 'st-1', code: 'STG-01', name: 'Temp 01', department: 'STAGING', status: 'ACTIVE',
      zoneId: 'z-1', zone: { id: 'z-1', code: 'TMP-ZONE' },
    });
    tx.temporaryStorageIntake.findUnique.mockResolvedValue(intake);
    tx.temporaryStorageIntake.update.mockImplementation(async ({ data }: any) => ({ ...intake, ...data }));

    const res = await svc.stageIntake('TMP-000001', { section: 'A-03' }, ACTOR);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('STAGED');
    expect(res.station).toEqual({ code: 'STG-01', name: 'Temp 01' });
    expect(res.zone).toEqual({ code: 'TMP-ZONE' });
    expect(res.section).toBe('A-03');
  });

  test('stageIntake rejects a non-STAGING station', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.temporaryStorageIntake.findUnique.mockResolvedValue({ id: 'tmp-1', code: 'TMP-000001', status: 'RECEIVED' });
    db.prisma.station.findFirst.mockResolvedValue({
      id: 'st-9', code: 'RCV-01', department: 'RECEIVING', status: 'ACTIVE', zoneId: null, zone: null,
    });
    await expect(svc.stageIntake('TMP-000001', {}, ACTOR)).rejects.toThrow(ConflictException);
  });

  test('stageIntake rejects a location outside the staging zone', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.temporaryStorageIntake.findUnique.mockResolvedValue({ id: 'tmp-1', code: 'TMP-000001', status: 'RECEIVED' });
    db.prisma.station.findFirst.mockResolvedValue({
      id: 'st-1', code: 'STG-01', name: 'Temp 01', department: 'STAGING', status: 'ACTIVE',
      zoneId: 'z-1', zone: { id: 'z-1', code: 'TMP-ZONE' },
    });
    db.prisma.location.findFirst.mockResolvedValue({
      id: 'l-1', locationCode: 'OTHER-01', status: 'ACTIVE', zoneId: 'z-other',
    });
    await expect(svc.stageIntake('TMP-000001', { locationCode: 'OTHER-01' }, ACTOR)).rejects.toThrow(ConflictException);
  });

  test('stageIntake rejects already-staged intakes', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.temporaryStorageIntake.findUnique.mockResolvedValue({ id: 'tmp-1', code: 'TMP-000001', status: 'STAGED' });
    await expect(svc.stageIntake('TMP-000001', {}, ACTOR)).rejects.toThrow(ConflictException);
  });

  test('forward transitions enforce RECEIVED -> STAGED -> READY_FOR_SORTING -> MOVED_TO_SORTING', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.temporaryStorageIntake.findUnique
      .mockResolvedValueOnce({ id: 'tmp-1', code: 'TMP-000001', status: 'RECEIVED', receivingSessionId: 'sess-1' })
      .mockResolvedValueOnce({ id: 'tmp-1', code: 'TMP-000001', status: 'STAGED', receivingSessionId: 'sess-1' });
    await expect(svc.markReadyForSorting('TMP-000001', ACTOR)).rejects.toThrow(ConflictException);

    tx.temporaryStorageIntake.findUnique.mockResolvedValue({ id: 'tmp-1', code: 'TMP-000001', status: 'STAGED', receivingSessionId: 'sess-1' });
    tx.temporaryStorageIntake.update.mockImplementation(async ({ data }: any) => ({ id: 'tmp-1', code: 'TMP-000001', status: 'READY_FOR_SORTING', readyAt: new Date(), ...data }));
    const ready = await svc.markReadyForSorting('TMP-000001', ACTOR);
    expect(ready.status).toBe('READY_FOR_SORTING');

    db.prisma.temporaryStorageIntake.findUnique.mockResolvedValue({ id: 'tmp-1', code: 'TMP-000001', status: 'READY_FOR_SORTING', receivingSessionId: 'sess-1' });
    tx.temporaryStorageIntake.findUnique.mockResolvedValue({ id: 'tmp-1', code: 'TMP-000001', status: 'READY_FOR_SORTING', receivingSessionId: 'sess-1' });
    tx.temporaryStorageIntake.update.mockImplementation(async ({ data }: any) => ({ id: 'tmp-1', code: 'TMP-000001', status: 'MOVED_TO_SORTING', movedAt: new Date(), ...data }));
    const moved = await svc.moveToSorting('TMP-000001', ACTOR);
    expect(moved.status).toBe('MOVED_TO_SORTING');
  });

  test('getIntake throws 404 for unknown codes', async () => {
    const tx = txMock();
    const db = { prisma: prismaMock(tx), tx };
    const { svc } = service(db);
    db.prisma.temporaryStorageIntake.findUnique.mockResolvedValue(null);
    await expect(svc.getIntake('TMP-999999')).rejects.toThrow(NotFoundException);
  });
});
