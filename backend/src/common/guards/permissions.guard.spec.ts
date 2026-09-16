import { ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermissions, RequireAnyPermission } from '../decorators/require-permissions.decorator';

/**
 * RBAC guard — AND list (`@RequirePermissions`) + OR list
 * (`@RequireAnyPermission`).
 *
 * The OR list exists for the handheld print agent (owner order 2026-09-16):
 * ONE endpoint serves six different shop-floor jobs, so requiring
 * `receiving.execute` alone locked a batch/sorting/packing worker out of
 * printing a label from their own CT40.
 */
function build(user: any, required?: string[], any?: string[]) {
  const handler: any = () => {};
  handler.__requiredPermissions = required;
  handler.__requiredAny = any;
  const context: any = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user, ip: '127.0.0.1', originalUrl: '/api/v1/print-jobs/pending' }) }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const guard = new PermissionsGuard({ getAllAndOverride: (key: string) => handler[key === 'requiredPermissions' ? '__requiredPermissions' : '__requiredAny'] } as any, audit as any);
  return { guard, context, audit };
}

const EXEC = ['receiving.execute', 'stowing.execute', 'picking.execute', 'packing.execute', 'shipping.execute', 'batch.execute'];

describe('RBAC — AND list + OR list (owner order 2026-09-16)', () => {
  it('no decorator = authenticated but not permission-gated', async () => {
    const { guard, context } = build({ id: 'u1', permissions: [] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('AND list still refuses when one of the listed permissions is missing', async () => {
    const { guard, context } = build({ id: 'u1', permissions: ['receiving.execute'] }, ['receiving.execute', 'inventory.manage']);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('AND list passes when every listed permission is granted', async () => {
    const { guard, context } = build({ id: 'u1', permissions: ['receiving.execute', 'inventory.manage'] }, ['receiving.execute', 'inventory.manage']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('OR list: ANY one of the six shop-floor rights opens the print agent', async () => {
    for (const p of EXEC) {
      const { guard, context } = build({ id: 'u1', permissions: [p] }, undefined, EXEC);
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it('OR list: an account with no execution right at all is still refused (and audited)', async () => {
    const { guard, context, audit } = build({ id: 'u1', permissions: ['admin.view'] }, undefined, EXEC);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UNAUTHORIZED_PERMISSION',
      metadata: expect.objectContaining({ requiredAny: EXEC }),
    }));
  });

  it('both lists on one route: AND list is required AND the OR list must match', async () => {
    const { guard, context } = build({ id: 'u1', permissions: ['receiving.execute', 'audit.view'] }, ['audit.view'], EXEC);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const second = build({ id: 'u1', permissions: ['admin.view'] }, ['audit.view'], EXEC);
    await expect(second.guard.canActivate(second.context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an unauthenticated request never reaches the OR list', async () => {
    const { guard, context } = build(undefined, undefined, EXEC);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the decorators write the metadata keys the guard reads', () => {
    expect(RequirePermissions('a', 'b')).toBeDefined();
    expect(RequireAnyPermission('a')).toBeDefined();
  });
});