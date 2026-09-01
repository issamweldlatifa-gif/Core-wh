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

    const service = new TerminalService(prisma, stations);
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

    // Two ready tasks are permitted, so the default would be the home grid;
    // the open putaway session must override that.
    expect(ctx.readyTaskCount).toBe(2);
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
    expect(ctx.readyTaskCount).toBe(1);
    expect(ctx.home).toBe('/terminal/receiving');
  });

  it('shows the terminal home when several ready tasks and no open work', async () => {
    const { service, user } = build({ receiving: null, putaway: null });

    const ctx = await service.context(user);

    expect(ctx.home).toBe('/terminal');
    expect(ctx.readyTaskCount).toBe(2);
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
    // Sorting has no workflow yet, so putaway is the only ready one.
    expect(ctx.home).toBe('/terminal/putaway');
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
