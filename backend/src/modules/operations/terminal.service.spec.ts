import { TerminalService } from './terminal.service';

/**
 * Routing contract of the Worker Terminal (spec §2/§3).
 *
 * The rules under test, in priority order:
 *   1. open work always wins over default routing (a refresh mid-task returns
 *      the worker to that exact task, whichever task it is),
 *   2. if both a receiving and a putaway session are open, the most recently
 *      started one wins,
 *   3. with no open work and exactly one ready task, the terminal opens it,
 *   4. with no open work and several/zero ready tasks, it shows the home grid,
 *   5. a worker is never routed anywhere by permissions they do not hold.
 */
describe('TerminalService.context routing', () => {
  const WORKER = 'user-1';

  function build(opts: {
    permissions?: string[];
    receiving?: { code: string; startedAt: Date } | null;
    putaway?: { code: string; startedAt: Date } | null;
    station?: unknown;
  }) {
    const receivingSession = {
      findFirst: jest.fn().mockResolvedValue(
        opts.receiving
          ? {
              id: 'rcv-1',
              code: opts.receiving.code,
              status: 'RECEIVING',
              startedAt: opts.receiving.startedAt,
              expectedArrival: { id: 'arr-1', code: 'WAR-000001', customerName: 'ACME' },
            }
          : null,
      ),
    };
    const putawaySession = {
      findFirst: jest.fn().mockResolvedValue(
        opts.putaway
          ? {
              id: 'put-1',
              code: opts.putaway.code,
              status: 'ACTIVE',
              startedAt: opts.putaway.startedAt,
            }
          : null,
      ),
    };
    const prisma = { receivingSession, putawaySession } as never;
    const stations = {
      forWorker: jest.fn().mockResolvedValue(
        opts.station === undefined
          ? { id: 's1', code: 'ST-REC-01', name: 'Receiving 1', department: 'RECEIVING', capabilities: [] }
          : opts.station,
      ),
    } as never;

    const service = new TerminalService(prisma, stations, {
      myAssignments: jest.fn(),
      completeAssignment: jest.fn(),
    } as never);
    const user = {
      id: WORKER,
      permissions: opts.permissions ?? ['receiving.execute', 'stowing.execute'],
    };
    return { service, user, receivingSession, putawaySession, stations };
  }

  it('resumes the putaway session when it started most recently', async () => {
    const { service, user } = build({
      receiving: { code: 'RCV-000202', startedAt: new Date('2026-09-01T10:00:00Z') },
      putaway: { code: 'PUT-000001', startedAt: new Date('2026-09-01T11:00:00Z') },
    });

    const ctx = await service.context(user);

    expect(ctx.resume).toMatchObject({ kind: 'PUTAWAY', code: 'PUT-000001', path: '/terminal/putaway' });
    expect(ctx.home).toBe('/terminal/putaway');
    expect(ctx.activeSession?.code).toBe('RCV-000202');
    expect(ctx.activePutaway?.code).toBe('PUT-000001');
  });

  it('resumes the receiving session when it started most recently', async () => {
    const { service, user } = build({
      receiving: { code: 'RCV-000202', startedAt: new Date('2026-09-01T12:00:00Z') },
      putaway: { code: 'PUT-000001', startedAt: new Date('2026-09-01T11:00:00Z') },
    });

    const ctx = await service.context(user);

    expect(ctx.resume).toMatchObject({ kind: 'RECEIVING', path: '/terminal/receiving' });
    expect(ctx.home).toBe('/terminal/receiving');
  });

  it('resumes open work even when it is not the only ready task', async () => {
    const { service, user } = build({
      receiving: null,
      putaway: { code: 'PUT-000002', startedAt: new Date('2026-09-01T09:00:00Z') },
    });

    const ctx = await service.context(user);

    // Several ready tasks are permitted (receiving + its tote sub-action +
    // sorting + putaway), so the default would be the home grid; the open
    // putaway session must override that.
    expect(ctx.readyTaskCount).toBe(4);
    expect(ctx.home).toBe('/terminal/putaway');
  });

  it('opens the single ready task directly when nothing is in flight', async () => {
    const { service, user } = build({
      permissions: ['receiving.execute'],
      receiving: null,
      putaway: null,
    });

    const ctx = await service.context(user);

    expect(ctx.resume).toBeNull();
    // receiving + its tote sub-action share ONE route, so the terminal still
    // opens straight into Receiving (routing counts DISTINCT paths).
    expect(ctx.readyTaskCount).toBe(2);
    expect(ctx.home).toBe('/terminal/receiving');
  });

  it('shows the terminal home when several ready tasks and no open work', async () => {
    const { service, user } = build({ receiving: null, putaway: null });

    const ctx = await service.context(user);

    expect(ctx.home).toBe('/terminal');
    expect(ctx.readyTaskCount).toBe(4);
  });

  it('never routes a worker without task permissions into another workspace', async () => {
    const { service, user } = build({ permissions: [], receiving: null, putaway: null });

    const ctx = await service.context(user);

    expect(ctx.tasks).toEqual([]);
    expect(ctx.readyTaskCount).toBe(0);
    expect(ctx.home).toBe('/terminal');
  });

  it('only offers tasks the worker is permitted to perform', async () => {
    const { service, user } = build({
      permissions: ['stowing.execute'],
      receiving: null,
      putaway: null,
    });

    const ctx = await service.context(user);

    expect(ctx.tasks.map((t) => t.key).sort()).toEqual(['putaway', 'sorting']);
    // Sorting and putaway are both ready now -> several choices, home grid.
    expect(ctx.home).toBe('/terminal');
  });

  it('scopes both session lookups to the requesting worker', async () => {
    const { service, user, receivingSession, putawaySession } = build({ receiving: null, putaway: null });

    await service.context(user);

    expect(receivingSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ startedBy: WORKER }) }),
    );
    expect(putawaySession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workerId: WORKER }) }),
    );
  });

  it('degrades to a null station instead of failing the terminal', async () => {
    const { service, user, stations } = build({ receiving: null, putaway: null });
    (stations as unknown as { forWorker: jest.Mock }).forWorker.mockRejectedValue(
      new Error('stations table missing'),
    );

    const ctx = await service.context(user);

    expect(ctx.station).toBeNull();
    expect(ctx.home).toBe('/terminal');
  });
});


describe('TerminalService.context — Temporary Storage task gating', () => {
  function build(station: unknown) {
    const prisma = {
      receivingSession: { findFirst: jest.fn().mockResolvedValue(null) },
      putawaySession: { findFirst: jest.fn().mockResolvedValue(null) },
    } as never;
    const stations = { forWorker: jest.fn().mockResolvedValue(station) } as never;
    const service = new TerminalService(prisma, stations, {
      myAssignments: jest.fn(),
      completeAssignment: jest.fn(),
    } as never);
    const user = { id: 'user-ts', permissions: ['receiving.execute'] };
    return { service, user };
  }

  it('only appears for workers bound to an ACTIVE STAGING station', async () => {
    // STAGING station -> the task is listed.
    const staging = build({ id: 's1', code: 'ST-STG-01', name: 'Temporary Storage 1', department: 'STAGING', capabilities: ['BARCODE_SCANNER'] });
    const stagedCtx = await staging.service.context(staging.user);
    expect(stagedCtx.tasks.some((t) => t.key === 'temporary-storage')).toBe(true);

    // A receiving worker with the same permission never sees it (dept gate).
    const recv = build({ id: 's2', code: 'ST-REC-01', name: 'Receiving 1', department: 'RECEIVING', capabilities: [] });
    const recvCtx = await recv.service.context(recv.user);
    expect(recvCtx.tasks.some((t) => t.key === 'temporary-storage')).toBe(false);

    // No station at all -> not listed (Temporary Storage always needs its station).
    const none = build(null);
    const noneCtx = await none.service.context(none.user);
    expect(noneCtx.tasks.some((t) => t.key === 'temporary-storage')).toBe(false);
  });

  it('registers the temporary-storage task with its terminal route, ready', async () => {
    const { service, user } = build({ id: 's1', code: 'ST-STG-01', name: 'Temporary Storage 1', department: 'STAGING', capabilities: [] });
    const ctx = await service.context(user);
    const t = ctx.tasks.find((x) => x.key === 'temporary-storage');
    expect(t).toMatchObject({
      label: 'Temporary Storage',
      path: '/terminal/temporary-storage',
      department: 'STAGING',
      permission: 'receiving.execute',
      ready: true,
    });
  });
});
