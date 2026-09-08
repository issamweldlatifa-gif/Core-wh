import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OperationsService } from './operations.service';

/**
 * ADMIN FORCE DATA DELETE (PART 4) — unit tests with a mocked prisma (no DB).
 *
 * Force delete is the admin-only escape hatch for data that has already
 * entered the worker workflow, which the normal soft-void refuses. The rules
 * under test: a reason is mandatory, the code must be typed back, physical
 * articles block the cleanup, the active workflow is terminated (assignments
 * CANCELLED) before the rows are removed, and the audit row is always kept.
 */

function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(),
    deleteMany: jest.fn(), count: jest.fn().mockResolvedValue(0),
  });
  const db: any = {
    expectedArrival: model(),
    warehouseShipment: model(),
    warehouseCarton: model(),
    receivingSession: model(),
    receivingCarton: model(),
    cartonPlacement: model(),
    articleUnit: model(),
    workerTaskAssignment: model(),
    auditLog: model(),
  };
  db.$transaction = jest.fn((action: any) => action(db));
  return db;
}

const ADMIN = { id: 'admin-1', ip: '10.0.0.9' };
const ARRIVAL = { id: 'arr-1', code: 'WAR-001001', status: 'RECEIVING', productCount: 3 };

describe('OperationsService — Admin Force Data Delete', () => {
  let service: OperationsService;
  let db: any;

  beforeEach(() => {
    db = prisma();
    service = new OperationsService(db, { log: jest.fn() } as any);
    db.expectedArrival.findFirst.mockResolvedValue(ARRIVAL);
    // One arrival held by an open receiving assignment = ACTIVE workflow.
    db.workerTaskAssignment.findMany.mockResolvedValue([
      { id: 'task-1', workerId: 'w-1', status: 'IN_PROGRESS', taskKey: 'receiving' },
    ]);
    db.receivingSession.findMany.mockResolvedValue([{ id: 'sess-1', code: 'RCV-1', status: 'RECEIVING' }]);
    db.warehouseShipment.findMany.mockResolvedValue([{ id: 'shp-1' }]);
  });

  const request = (over: Record<string, unknown> = {}) => ({
    kind: 'arrival' as const,
    code: 'WAR-001001',
    reason: 'Test data stuck in receiving',
    confirm: 'WAR-001001',
    ...over,
  });

  describe('preview', () => {
    it('reports the active workflow that the force delete would terminate', async () => {
      const report: any = await service.dataControlForceDeletePreview('arrival', undefined, 'WAR-001001');
      expect(report.active).toBe(true);
      expect(report.currentStatus).toBe('RECEIVING');
      expect(report.assignedWorkers).toEqual(['w-1']);
      expect(report.willTerminate).toMatchObject({ receivingSessions: 1, openAssignments: 1 });
      // The dialog needs to know what the admin must type back.
      expect(report.requiresConfirmation).toBe('WAR-001001');
    });

    it('does not mutate anything', async () => {
      await service.dataControlForceDeletePreview('arrival', undefined, 'WAR-001001');
      expect(db.expectedArrival.delete).not.toHaveBeenCalled();
      expect(db.workerTaskAssignment.updateMany).not.toHaveBeenCalled();
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s on an unknown code', async () => {
      db.expectedArrival.findFirst.mockResolvedValue(null);
      await expect(service.dataControlForceDeletePreview('arrival', undefined, 'NOPE')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('guards', () => {
    it('refuses a force delete with no written reason', async () => {
      await expect(service.dataControlForceDelete(request({ reason: '' }), ADMIN))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(db.expectedArrival.delete).not.toHaveBeenCalled();
    });

    it('refuses when the typed confirmation does not match the code', async () => {
      await expect(service.dataControlForceDelete(request({ confirm: 'WAR-000000' }), ADMIN))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(db.expectedArrival.delete).not.toHaveBeenCalled();
    });

    it('refuses to destroy data that already produced physical articles', async () => {
      db.articleUnit.count.mockResolvedValue(4);
      await expect(service.dataControlForceDelete(request(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
      expect(db.expectedArrival.delete).not.toHaveBeenCalled();
    });
  });

  describe('execution', () => {
    it('cancels the active assignment, then removes cartons, shipments and the arrival', async () => {
      const result: any = await service.dataControlForceDelete(request(), ADMIN);

      // 1) active workflow terminated with the reason attached
      expect(db.workerTaskAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['task-1'] } },
          data: expect.objectContaining({
            status: 'CANCELLED',
            cancelReason: 'FORCE_DELETE: Test data stuck in receiving',
          }),
        }),
      );
      // 2) dependent operational data removed (no orphan carton cards)
      expect(db.warehouseCarton.deleteMany).toHaveBeenCalledWith({ where: { shipmentId: { in: ['shp-1'] } } });
      expect(db.warehouseShipment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['shp-1'] } } });
      expect(db.expectedArrival.delete).toHaveBeenCalledWith({ where: { id: 'arr-1' } });

      expect(result).toMatchObject({ ok: true, action: 'FORCE_DELETE', cancelledAssignments: 1 });
    });

    it('always writes an audit row carrying the actor, reason and previous status', async () => {
      await service.dataControlForceDelete(request(), ADMIN);
      const entry = db.auditLog.create.mock.calls[0][0].data;
      expect(entry).toMatchObject({ actorUserId: 'admin-1', action: 'DATA_FORCE_DELETED', entityId: 'WAR-001001' });
      expect(entry.metadata).toMatchObject({
        action: 'FORCE_DELETE',
        reason: 'Test data stuck in receiving',
        previousStatus: 'RECEIVING',
        assignedWorkers: ['w-1'],
      });
    });

    it('audits before deleting, so a failed cleanup still leaves the trace', async () => {
      db.expectedArrival.delete.mockRejectedValue(new Error('db down'));
      await expect(service.dataControlForceDelete(request(), ADMIN)).rejects.toThrow('db down');
      expect(db.auditLog.create).toHaveBeenCalled();
    });

    it('force deletes a carton and its placements', async () => {
      db.warehouseCarton.findFirst.mockResolvedValue({
        id: 'c-1', externalCartonId: 'CTN-1', qrCodeValue: null, barcodeValue: null, status: 'EXPECTED',
      });
      const result: any = await service.dataControlForceDelete(
        { kind: 'carton', code: 'CTN-1', reason: 'bad test carton', confirm: 'CTN-1' },
        ADMIN,
      );
      expect(db.cartonPlacement.deleteMany).toHaveBeenCalledWith({ where: { cartonId: 'c-1' } });
      expect(db.warehouseCarton.delete).toHaveBeenCalledWith({ where: { id: 'c-1' } });
      expect(result).toMatchObject({ ok: true, kind: 'carton', code: 'CTN-1' });
    });
  });
});
