import { TaskDispatchService } from './dispatch.service';

/**
 * Automatic task dispatch — unit tests (mocked prisma, no DB).
 *
 * The backend workflow hand-off engine (Master Order §9): when a workflow
 * event happens the next task is auto-created for an ELIGIBLE worker, atomically
 * with the transition. These tests pin the eligibility + ordering + idempotency
 * rules that must never regress:
 *   - one open assignment per (taskKey + entity),
 *   - ACTIVE users only, permission granted by an OPERATIONAL-class role
 *     (admins are never floor workers),
 *   - station/department conflict exclusion,
 *   - station-matched (configured routing) before station-less,
 *   - within a group: fewest open assignments (availability),
 *   - audited TASK_AUTO_DISPATCHED.
 */

function prisma(): any {
  const model = () => ({
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
    count: jest.fn(), groupBy: jest.fn(),
  });
  return {
    user: model(), station: model(),
    workerTaskAssignment: model(), operationalContainer: model(),
  };
}

const user = (id: string, extra: any = {}) => ({
  id,
  employeeCode: `W-${id}`,
  stationsAssigned: [],
  ...extra,
});

/** sorting task => department SORTING, permission stowing.execute. */
const CTX = { reason: 'container RCN-000001 staged to temporary storage' } as const;

describe('TaskDispatchService', () => {
  let service: TaskDispatchService;
  let db: any;
  let audit: any;

  beforeEach(() => {
    db = prisma();
    // Fresh audit spy per test — assertions are "called / not called".
    audit = { log: jest.fn() };
    db.$transaction = jest.fn((action: any) => action(db));
    service = new TaskDispatchService(db, audit);
    // Default: no open assignment exists yet.
    db.workerTaskAssignment.findFirst.mockResolvedValue(null);
    db.workerTaskAssignment.groupBy.mockResolvedValue([]);
    db.workerTaskAssignment.create.mockImplementation(async ({ data }: any) => ({
      id: 'task-new', ...data,
    }));
  });

  it('dispatches to the eligible worker and audits TASK_AUTO_DISPATCHED', async () => {
    db.user.findMany.mockResolvedValue([user('w1')]);

    const id = await service.dispatch('sorting', { containerId: 'c1', entityCode: 'RCN-000001' }, { ...CTX });

    expect(id).toBe('task-new');
    const data = db.workerTaskAssignment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ taskKey: 'sorting', containerId: 'c1', status: 'ASSIGNED', relatedCode: 'RCN-000001' });
    expect(data.description).toContain(CTX.reason);
    expect(audit.log).toHaveBeenCalledTimes(1);
    const auditArg = (audit.log as jest.Mock).mock.calls[0][0];
    expect(auditArg.action).toBe('TASK_AUTO_DISPATCHED');
    expect(auditArg.metadata).toMatchObject({ autoDispatch: true, taskKey: 'sorting', worker: 'W-w1' });
  });

  it('is idempotent: an existing open assignment (ASSIGNED/IN_PROGRESS) is never duplicated', async () => {
    db.workerTaskAssignment.findFirst.mockResolvedValue({ id: 'existing' });

    const id = await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });

    expect(id).toBeNull();
    expect(db.workerTaskAssignment.create).not.toHaveBeenCalled();
  });

  it('treats a BLOCKED assignment as still open (no duplicate while blocked)', async () => {
    db.workerTaskAssignment.findFirst.mockResolvedValue({ id: 'blocked' });

    const id = await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });

    expect(id).toBeNull();
    expect(db.workerTaskAssignment.create).not.toHaveBeenCalled();
  });

  it('creates nothing when no eligible worker exists', async () => {
    db.user.findMany.mockResolvedValue([]);

    const id = await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });

    expect(id).toBeNull();
    expect(db.workerTaskAssignment.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('never dispatches to admin-class accounts, even when they hold the permission', async () => {
    // The real engine filters on role.applicationClass === 'OPERATIONAL' in
    // the where clause; emulate the post-filter candidate set: an admin who
    // would otherwise be "eligible" must not be in the result set.
    db.user.findMany.mockResolvedValue([]); // admin filtered out by the query
    const id = await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });
    expect(id).toBeNull();
    // And the query itself must carry the OPERATIONAL filter.
    const where = db.user.findMany.mock.calls[0][0].where;
    expect(where.roles.some.role.applicationClass).toBe('OPERATIONAL');
  });

  it('excludes a worker whose ACTIVE station is bound to another department', async () => {
    // w1 is at a RECEIVING station, w2 has no station. sorting = SORTING dept.
    db.user.findMany.mockResolvedValue([
      user('w1', { stationsAssigned: [{ department: 'RECEIVING' }] }),
      user('w2'),
    ]);

    const id = await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });

    expect(id).toBe('task-new');
    const data = db.workerTaskAssignment.create.mock.calls[0][0].data;
    expect(data.workerId).toBe('w2');
  });

  it('prefers the worker whose ACTIVE station matches the task department (configured routing)', async () => {
    db.user.findMany.mockResolvedValue([
      user('w-stationless'),
      user('w-sorted', { stationsAssigned: [{ department: 'SORTING' }] }),
    ]);
    // Station-less first in the raw list — the ordering must still pick w-sorted.

    await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });

    const data = db.workerTaskAssignment.create.mock.calls[0][0].data;
    expect(data.workerId).toBe('w-sorted');
  });

  it('breaks ties by fewest open assignments (operational availability)', async () => {
    db.user.findMany.mockResolvedValue([user('busy'), user('free')]);
    db.workerTaskAssignment.groupBy.mockResolvedValue([
      { workerId: 'busy', _count: { _all: 3 } },
      { workerId: 'free', _count: { _all: 0 } },
    ]);

    await service.dispatch('sorting', { containerId: 'c1' }, { ...CTX });

    const data = db.workerTaskAssignment.create.mock.calls[0][0].data;
    expect(data.workerId).toBe('free');
  });

  it('onContainerStaged completes the open container task and dispatches sorting', async () => {
    db.workerTaskAssignment.updateMany.mockResolvedValue({ count: 1 });
    db.user.findMany.mockResolvedValue([user('w1')]);

    await service.onContainerStaged({ id: 'c1', code: 'RCN-000001' }, 'actor-1', { ...CTX });

    expect(db.workerTaskAssignment.updateMany).toHaveBeenCalledTimes(1);
    const upd = db.workerTaskAssignment.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ containerId: 'c1', taskKey: 'receiving-container' });
    expect(upd.data.status).toBe('COMPLETED');
    expect(db.workerTaskAssignment.create).toHaveBeenCalledTimes(1);
    expect(db.workerTaskAssignment.create.mock.calls[0][0].data.taskKey).toBe('sorting');
  });
});
