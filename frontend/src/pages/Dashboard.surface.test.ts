import { describe, expect, it } from 'vitest';
import { resolveDashboard } from './Dashboard';

/**
 * Order #3 application-surface routing (AYROVI ADMIN_WEB/WORKER endpoint
 * conflict regression). The session's `application` is server truth; the
 * dashboard it renders must only ever call that surface's API:
 *
 *   WORKER_NATIVE -> worker dashboard  (terminal/receiving worker API)
 *   ADMIN_WEB     -> admin dashboard   (operations admin API) or read-only
 *
 * An ADMIN_WEB session must NEVER resolve to the worker dashboard: the worker
 * endpoints reject it with 403 "reserved for the Worker application".
 */
describe('resolveDashboard (application surface)', () => {
  const workerPerms = ['receiving.execute', 'receiving.view'];
  const adminPerms = ['operations.view', 'receiving.execute', 'receiving.view'];
  const viewerPerms = ['warehouses.view', 'receiving.view'];

  it('routes a WORKER_NATIVE session to the worker dashboard even with admin permissions', () => {
    // Multi-role user who opened the Worker app: their session is WORKER_NATIVE,
    // so the admin operations API would 403 — they get the worker workspace.
    expect(resolveDashboard('WORKER_NATIVE', [...workerPerms, ...adminPerms])).toBe('worker');
  });

  it('routes an ADMIN_WEB session with operations.view to the admin dashboard', () => {
    expect(resolveDashboard('ADMIN_WEB', adminPerms)).toBe('admin');
  });

  it('routes an ADMIN_WEB session with receiving.execute but no operations.view to read-only', () => {
    // The exact shape of the reported bug: an admin-class session holding
    // receiving.execute must NOT be routed into the worker workspace.
    expect(resolveDashboard('ADMIN_WEB', ['receiving.execute', 'receiving.view'])).toBe('readonly');
  });

  it('routes an ADMIN_WEB VIEWER session (no operations.view, no execute) to read-only', () => {
    expect(resolveDashboard('ADMIN_WEB', viewerPerms)).toBe('readonly');
  });

  it('falls back to permission-based routing when the surface is unknown (legacy token)', () => {
    expect(resolveDashboard(undefined, adminPerms)).toBe('admin');
    expect(resolveDashboard(undefined, workerPerms)).toBe('worker');
    expect(resolveDashboard(undefined, viewerPerms)).toBe('readonly');
  });
});
