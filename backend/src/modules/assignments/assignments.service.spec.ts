import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssignmentsService, WorkPolicyService, WORKER_ISSUE_TYPES } from './assignments.service';

/**
 * Worker operational assignments — unit tests (mocked prisma, no DB).
 *
 * Covers the §5 lifecycle rules the backend owns: entity resolution, the
 * ASSIGNED lifecycle transitions driven by the workflows, and §41 issue
 * reporting (type validation + discrepancy creation when a session is given).
 */

/**
 * Prisma double: exactly the models this service touches, every method a
 * fresh jest mock. Typed `any` on purpose — this spec tests service logic,
 * not prisma typing.
 */
function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
    count: jest.fn(), groupBy: jest.fn(),
  });
  return {
    user: model(), expectedArrival: model(), warehouseCarton: model(),
    operationalContainer: model(), outboundShipment: model(), warehouseOrder: model(),
    station: model(), workerTaskAssignment: model(), receivingSession: model(),
    receivingDiscrepancy: model(), auditLog: model(), orderItem: model(),
    articleUnit: model(),
  };
}

const audit = { log: jest.fn() } as never;

describe('AssignmentsService (operational model)', () => {
  let service: AssignmentsService;
  let db: any;

  beforeEach(() => {
    db = prisma();
    db.$transaction = jest.fn((action: any) => action(db));
    service = new AssignmentsService(db, audit);
  });

  describe('create (admin assigns a task)', () => {
    it('derives the receiving task from an ARRIVAL code and links the entity', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'w1', status: 'ACTIVE', employeeCode: 'WORKER001' });
      db.expectedArrival.findFirst.mockResolvedValue({ id: 'arr-1', code: 'WAR-2026-0001' });
      db.station.findUnique.mockResolvedValue(null);
      db.workerTaskAssignment.create.mockResolvedValue({
        id: 'a1', status: 'ASSIGNED', taskKey: 'receiving', title: 'Receive arrival WAR-2026-0001',
      });

      const res = await service.create(
        { workerId: 'w1', relatedType: 'ARRIVAL', relatedCode: 'WAR-2026-0001' },
        { id: 'admin-1' },
      );

      expect(res).toMatchObject({ ok: true, id: 'a1', status: 'ASSIGNED', taskKey: 'receiving' });
      const arg = db.workerTaskAssignment.create.mock.calls[0][0].data;
      expect(arg.arrivalId).toBe('arr-1');
      expect(arg.taskKey).toBe('receiving');
      expect(arg.title).toContain('WAR-2026-0001');
      expect(arg.status).toBe('ASSIGNED');
    });

    it('rejects an unknown task key with the known catalog', async () => {
      await expect(
        service.create({ workerId: 'w1', taskKey: 'teleportation' }, { id: 'admin-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unknown arrival code instead of guessing', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'w1', status: 'ACTIVE' });
      db.expectedArrival.findFirst.mockResolvedValue(null);
      await expect(
        service.create({ workerId: 'w1', relatedType: 'ARRIVAL', relatedCode: 'WAR-NOPE' }, { id: 'admin-1' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('workflow-driven lifecycle', () => {
    it('receivingStarted flips ASSIGNED → IN_PROGRESS and audits TASK_IN_PROGRESS', async () => {
      db.workerTaskAssignment.updateMany.mockResolvedValue({ count: 2 });
      db.auditLog.create.mockResolvedValue({});
      const n = await service.receivingStarted('arr-1', 'RCV-000210', 'w1');
      expect(n).toBe(2);
      const upd = db.workerTaskAssignment.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ arrivalId: 'arr-1', workerId: 'w1', taskKey: 'receiving', status: 'ASSIGNED' });
      expect(upd.data.status).toBe('IN_PROGRESS');
      expect(db.auditLog.create).toHaveBeenCalled();
    });

    it('receivingCompleted closes as COMPLETED_WITH_DISCREPANCY when discrepancies remain', async () => {
      db.workerTaskAssignment.updateMany.mockResolvedValue({ count: 1 });
      db.auditLog.create.mockResolvedValue({});
      await service.receivingCompleted('arr-1', true, 'RCV-000210', 'w1');
      const upd = db.workerTaskAssignment.updateMany.mock.calls[0][0];
      expect(upd.data.status).toBe('COMPLETED_WITH_DISCREPANCY');
      expect(upd.data.completedById).toBe('w1');
    });

    it('cartonStored / containerPacked / outboundShipped all close open assignments', async () => {
      db.workerTaskAssignment.updateMany.mockResolvedValue({ count: 1 });
      db.auditLog.create.mockResolvedValue({});
      expect(await service.cartonStored('c1', 'w2')).toBe(1);
      expect(await service.containerPacked('bin1', 'w3')).toBe(1);
      expect(await service.outboundShipped('out1', 'w4')).toBe(1);
      for (const call of db.workerTaskAssignment.updateMany.mock.calls) {
        expect(call[0].where.status).toEqual({ in: ['ASSIGNED', 'IN_PROGRESS'] });
        expect(call[0].data.status).toBe('COMPLETED');
      }
    });
  });

  describe('worker-side completion', () => {
    it('lets the assigned worker close their own task, but nobody else\'s', async () => {
      db.workerTaskAssignment.findUnique.mockResolvedValue({
        id: 'a1', workerId: 'w1', status: 'ASSIGNED', title: 'T',
      });
      db.workerTaskAssignment.updateMany.mockResolvedValue({ count: 1 });
      db.auditLog.create.mockResolvedValue({});
      await expect(service.completeAssignment('w1', 'a1', 'done')).resolves.toMatchObject({ ok: true });
      await expect(service.completeAssignment('w2', 'a1', 'done')).rejects.toThrow(NotFoundException);
    });
  });

  describe('completion security', () => {
    it('blocks manual completion of operational entity tasks and blocked instructions', async () => {
      for (const row of [
        { taskKey: 'receiving', arrivalId: 'arrival', status: 'ASSIGNED' },
        { containerId: 'container', status: 'IN_PROGRESS' },
        { status: 'BLOCKED' },
      ]) {
        db.workerTaskAssignment.findUnique.mockResolvedValue({ id: 'task', workerId: 'w1', title: 'Work', ...row });
        await expect(service.completeAssignment('w1', 'task')).rejects.toThrow();
      }
      expect(db.workerTaskAssignment.updateMany).not.toHaveBeenCalled();
    });
    it('compare-and-set failure cannot create a second completion audit', async () => {
      db.workerTaskAssignment.findUnique.mockResolvedValue({ id: 'task', workerId: 'w1', title: 'Instruction', status: 'ASSIGNED' });
      db.workerTaskAssignment.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.completeAssignment('w1', 'task')).rejects.toThrow('already changed');
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
    it('denies another worker or a blocked linked task', async () => {
      db.workerTaskAssignment.findMany.mockResolvedValue([{ id: 'task', workerId: 'w2', status: 'ASSIGNED' }]);
      await expect(service.assertOperationalAccess('w1', 'receiving', { arrivalId: 'arrival' })).rejects.toThrow(ForbiddenException);
      db.workerTaskAssignment.findMany.mockResolvedValue([{ id: 'task', workerId: 'w1', status: 'BLOCKED' }]);
      await expect(service.assertOperationalAccess('w1', 'receiving', { arrivalId: 'arrival' })).rejects.toThrow(ForbiddenException);
    });
  });

  describe('reportIssue (§41 / C-16)', () => {
    it('exposes exactly the specified issue vocabulary', () => {
      expect([...WORKER_ISSUE_TYPES]).toEqual([
        'SHORTAGE', 'OVERAGE', 'UNKNOWN_CARTON', 'WRONG_SHIPMENT',
        'UNEXPECTED_PRODUCT', 'MISSING_PRODUCT', 'MISSING_CARTON',
        'IDENTIFICATION_ERROR', 'OTHER',
      ]);
    });

    it('rejects unknown types and empty descriptions', async () => {
      await expect(service.reportIssue({ type: 'ALIEN', description: 'x' }, { id: 'w1' })).rejects.toThrow(BadRequestException);
      await expect(service.reportIssue({ type: 'SHORTAGE', description: '' }, { id: 'w1' })).rejects.toThrow(BadRequestException);
    });

    it('creates an OPEN discrepancy when a receiving session is referenced', async () => {
      db.receivingSession.findUnique.mockResolvedValue({ id: 's1' });
      db.receivingDiscrepancy.create.mockResolvedValue({ id: 'd1' });
      db.auditLog.create.mockResolvedValue({});
      const res = await service.reportIssue(
        { type: 'MISSING_CARTON', description: 'carton 3 of 5 never arrived', sessionId: 's1' },
        { id: 'w1' },
      );
      expect(res).toEqual({ ok: true, discrepancyId: 'd1' });
      const disc = db.receivingDiscrepancy.create.mock.calls[0][0].data;
      expect(disc.status).toBe('OPEN');
      expect(disc.type).toBe('MISSING_CARTON');
      const log = db.auditLog.create.mock.calls[0][0].data;
      expect(log.action).toBe('WORKER_ISSUE_REPORTED');
    });
  });
});

describe('WorkPolicyService (station ↔ department, §22)', () => {
  it('allows a worker whose station matches the department', async () => {
    const db = prisma();
    db.station.findFirst.mockResolvedValue({ id: 'st1', code: 'ST-REC-01', department: 'RECEIVING' });
    db.auditLog.create.mockResolvedValue({});
    const policy = new WorkPolicyService(db, audit);
    await expect(policy.assertDepartment('w1', 'RECEIVING')).resolves.toBeUndefined();
  });

  it('blocks and audits a department mismatch', async () => {
    const db = prisma();
    db.station.findFirst.mockResolvedValue({ id: 'st1', code: 'ST-REC-01', department: 'RECEIVING' });
    db.auditLog.create.mockResolvedValue({});
    const policy = new WorkPolicyService(db, audit);
    await expect(policy.assertDepartment('w1', 'PACKING')).rejects.toThrow(ForbiddenException);
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it('allows a worker with no station (station is optional by design)', async () => {
    const db = prisma();
    db.station.findFirst.mockResolvedValue(null);
    const policy = new WorkPolicyService(db, audit);
    await expect(policy.assertDepartment('w1', 'PACKING')).resolves.toBeUndefined();
  });
});
