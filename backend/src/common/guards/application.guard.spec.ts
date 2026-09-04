import { ForbiddenException } from '@nestjs/common';
import { ApplicationGuard } from './application.guard';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

function ctxWith(user?: Partial<AuthenticatedUser>, handlerMeta?: unknown) {
  const getHandler = () => ({} as any);
  const getClass = () => ({} as any);
  const reflector = {
    getAllAndOverride: jest.fn(() => handlerMeta),
  } as any;
  const context = {
    getHandler,
    getClass,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as any;
  // No AuditService in unit tests — denial logging is skipped.
  return { guard: new ApplicationGuard(reflector), context };
}

const adminUser: AuthenticatedUser = {
  id: 'u1',
  employeeCode: 'A1',
  name: 'Admin',
  roles: ['SUPER_ADMIN'],
  permissions: [],
  sessionId: 's1',
  application: 'ADMIN_WEB',
  allowedApplications: ['ADMIN_WEB'],
};

const workerUser: AuthenticatedUser = {
  id: 'u2',
  employeeCode: 'W1',
  name: 'Worker',
  roles: ['INBOUND_WORKER'],
  permissions: [],
  sessionId: 's2',
  application: 'WORKER_NATIVE',
  allowedApplications: ['WORKER_NATIVE'],
};

describe('ApplicationGuard (strict Admin/Worker surface boundary)', () => {
  it('passes every session when no surface is declared (opt-in)', async () => {
    const { guard, context } = ctxWith(adminUser, undefined);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects an ADMIN_WEB session calling a WORKER_NATIVE endpoint', async () => {
    const { guard, context } = ctxWith(adminUser, 'WORKER_NATIVE');
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a WORKER_NATIVE session calling an ADMIN_WEB endpoint', async () => {
    const { guard, context } = ctxWith(workerUser, 'ADMIN_WEB');
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows a worker session on its own WORKER_NATIVE endpoint', async () => {
    const { guard, context } = ctxWith(workerUser, 'WORKER_NATIVE');
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects when the session surface matches but roles cannot open it', async () => {
    // Session says WORKER_NATIVE but the DB-derived allowedApplications
    // disagree — the server never trusts the session alone.
    const weird: AuthenticatedUser = {
      ...workerUser,
      allowedApplications: ['ADMIN_WEB'],
    };
    const { guard, context } = ctxWith(weird, 'WORKER_NATIVE');
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
