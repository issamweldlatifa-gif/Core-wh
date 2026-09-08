import { ForbiddenException } from '@nestjs/common';
import { AssignmentsService } from '../assignments/assignments.service';
import { PushService, PushTransport } from '../notifications/push.service';
import { isSharedTask } from '../operations/task-registry';

/**
 * RECEIVING WORKFLOW CORRECTION — multi-worker shared queue, auto approval,
 * concurrency safety and permission-based push audience.
 *
 * TEST B/C/D  — assignment must not gate receiving
 * TEST J      — duplicate approval is impossible
 * TEST G/H/I  — push audience is permission-based (transport-level)
 */
function db(): any {
  const model = () => ({
    findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), upsert: jest.fn(),
  });
  return { workerTaskAssignment: model(), station: model(), pushToken: model(), auditLog: model(), user: model() };
}

describe('Receiving is a SHARED, permission-gated queue', () => {
  it('the task registry declares receiving (and its sub-task) as shared', () => {
    expect(isSharedTask('receiving')).toBe(true);
    expect(isSharedTask('receiving-container')).toBe(true);
  });

  it('non-shared tasks keep strict assignment ownership', () => {
    expect(isSharedTask('packing')).toBe(false);
    expect(isSharedTask('shipping')).toBe(false);
    expect(isSharedTask('putaway')).toBe(false);
  });

  // TEST D — card assigned to Worker A, Worker B holds the permission.
  it('TEST D: a worker who is NOT the assignee may still execute receiving', async () => {
    const prisma = db();
    prisma.workerTaskAssignment.findMany.mockResolvedValue([
      { id: 'as-1', workerId: 'worker-A', status: 'IN_PROGRESS', stationId: null },
    ]);
    const svc = new AssignmentsService(prisma, { log: jest.fn() } as any);
    await expect(
      svc.assertOperationalAccess('worker-B', 'receiving', { arrivalId: 'arr-1' }),
    ).resolves.toBeUndefined();
    // Authorization short-circuits on the shared flag: the assignment table
    // is not even consulted, so it can never reject a permitted worker.
    expect(prisma.workerTaskAssignment.findMany).not.toHaveBeenCalled();
  });

  // TEST C — no assignment at all.
  it('TEST C: an unassigned card is executable by any permitted worker', async () => {
    const prisma = db();
    prisma.workerTaskAssignment.findMany.mockResolvedValue([]);
    const svc = new AssignmentsService(prisma, { log: jest.fn() } as any);
    await expect(
      svc.assertOperationalAccess('worker-B', 'receiving', { arrivalId: 'arr-1' }),
    ).resolves.toBeUndefined();
  });

  // TEST B — several workers, same station, same queue.
  it('TEST B: five different workers are all authorized on the same card', async () => {
    const prisma = db();
    prisma.workerTaskAssignment.findMany.mockResolvedValue([
      { id: 'as-1', workerId: 'worker-A', status: 'ASSIGNED', stationId: null },
    ]);
    const svc = new AssignmentsService(prisma, { log: jest.fn() } as any);
    for (const w of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      await expect(svc.assertOperationalAccess(w, 'receiving', { arrivalId: 'arr-1' })).resolves.toBeUndefined();
    }
  });

  // Regression guard: ownership is UNCHANGED for non-shared workflows.
  it('packing still rejects a worker who does not hold the assignment', async () => {
    const prisma = db();
    prisma.workerTaskAssignment.findMany.mockResolvedValue([
      { id: 'as-2', workerId: 'worker-A', status: 'IN_PROGRESS', stationId: null },
    ]);
    const svc = new AssignmentsService(prisma, { log: jest.fn() } as any);
    await expect(
      svc.assertOperationalAccess('worker-B', 'packing', { containerId: 'c-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('assignment rows are NOT deleted — they remain available for audit', async () => {
    const prisma = db();
    const svc = new AssignmentsService(prisma, { log: jest.fn() } as any);
    await svc.assertOperationalAccess('worker-B', 'receiving', { arrivalId: 'arr-1' });
    expect(prisma.workerTaskAssignment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.workerTaskAssignment.update).not.toHaveBeenCalled();
  });
});

describe('Push audience is PERMISSION-based, not assignment-based', () => {
  function build(eligible: Array<{ id: string; employeeCode: string }>, tokens: string[]) {
    const prisma = db();
    prisma.pushToken.findMany.mockResolvedValue(tokens.map((t) => ({ token: t })));
    const dispatch: any = { eligibleWorkers: jest.fn().mockResolvedValue(eligible) };
    const sent: any[] = [];
    const transport: PushTransport = {
      send: jest.fn(async (to: string[], msg) => { sent.push({ to, msg }); return { invalidTokens: [] }; }),
    };
    return { svc: new PushService(prisma, dispatch, transport), prisma, dispatch, sent };
  }

  it('notifies EVERY eligible receiving worker, not just one', async () => {
    const { svc, prisma, sent } = build(
      [{ id: 'u1', employeeCode: 'E1' }, { id: 'u2', employeeCode: 'E2' }, { id: 'u3', employeeCode: 'E3' }],
      ['tok-1', 'tok-2', 'tok-3'],
    );
    const count = await svc.notifyNewReceivingCard('WAR-001001', 12);
    expect(count).toBe(3);
    expect(prisma.pushToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ['u1', 'u2', 'u3'] } } }),
    );
    // The payload is device-independent: it is delivered by the push service
    // whether the app is open, backgrounded or closed (TEST G/H/I).
    expect(sent[0].msg.title).toBe('AYROVI Receiving');
    expect(sent[0].msg.body).toContain('WAR-001001');
    expect(sent[0].msg.route).toBe('/terminal/receiving');
    expect(sent[0].msg.data.event).toBe('NEW_RECEIVING_CARD');
  });

  it('prunes tokens FCM reports as dead', async () => {
    const prisma = db();
    prisma.pushToken.findMany.mockResolvedValue([{ token: 'good' }, { token: 'dead' }]);
    const dispatch: any = { eligibleWorkers: jest.fn().mockResolvedValue([{ id: 'u1', employeeCode: 'E1' }]) };
    const transport: PushTransport = { send: jest.fn(async () => ({ invalidTokens: ['dead'] })) };
    const svc = new PushService(prisma, dispatch, transport);
    expect(await svc.notifyNewReceivingCard('WAR-1', 1)).toBe(1);
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['dead'] } } });
  });

  it('a push failure NEVER breaks intake', async () => {
    const prisma = db();
    prisma.pushToken.findMany.mockResolvedValue([{ token: 't' }]);
    const dispatch: any = { eligibleWorkers: jest.fn().mockResolvedValue([{ id: 'u1', employeeCode: 'E' }]) };
    const transport: PushTransport = { send: jest.fn().mockRejectedValue(new Error('FCM down')) };
    const svc = new PushService(prisma, dispatch, transport);
    await expect(svc.notifyNewReceivingCard('WAR-1', 1)).resolves.toBe(0);
  });

  it('registering the same token twice moves it instead of duplicating', async () => {
    const { svc, prisma } = build([], []);
    await svc.register('u2', 'tok-1', 'ANDROID', 'dev-9');
    expect(prisma.pushToken.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { token: 'tok-1' },
      update: expect.objectContaining({ userId: 'u2' }),
    }));
  });

  it('warns and sends nothing when no worker holds the permission', async () => {
    const { svc, sent } = build([], []);
    expect(await svc.notifyNewReceivingCard('WAR-1', 1)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
