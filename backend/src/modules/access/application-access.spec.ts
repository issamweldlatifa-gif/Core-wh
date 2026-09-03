/**
 * Order #3 §16 — Acceptance tests for the strict Admin/Worker isolation.
 *
 * These are the pure, server-side policy tests. Rows that need live database /
 * device rows (station binding, device registry) are represented here by
 * passing the server-derived inputs; the DB layer tests that PRODUCE those
 * inputs belong to later phases (A3/B1).
 */
import {
  applicationsAllowedByRoles,
  classifyRole,
  evaluateAccess,
  type AccessDecision,
} from './application-access';

describe('Order#3 §16 Acceptance — application isolation policy', () => {
  it('Test 1 — Admin identity + WORKER_NATIVE → denied, no worker session', () => {
    const d: AccessDecision = evaluateAccess({
      application: 'WORKER_NATIVE',
      roles: ['SUPER_ADMIN'],
      accountActive: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('APPLICATION_NOT_ALLOWED_BY_ROLES');
  });

  it('Test 2 — Worker identity + ADMIN_WEB → denied, no admin session', () => {
    const d = evaluateAccess({
      application: 'ADMIN_WEB',
      roles: ['INBOUND_WORKER'],
      accountActive: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('APPLICATION_NOT_ALLOWED_BY_ROLES');
  });

  it('Test 3 — Worker + unauthorized station → 403 (STATION_NOT_AUTHORIZED)', () => {
    const d = evaluateAccess({
      application: 'WORKER_NATIVE',
      roles: ['INBOUND_WORKER'],
      accountActive: true,
      requiredPermission: 'receiving.execute',
      grantedPermissions: ['receiving.execute'],
      stationId: 'RECEIVING-02',
      allowedStations: ['RECEIVING-01'],
      deviceAuthorized: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('STATION_NOT_AUTHORIZED');
  });

  it('Test 4 — Worker + unauthorized permission → 403 (PERMISSION_DENIED)', () => {
    const d = evaluateAccess({
      application: 'WORKER_NATIVE',
      roles: ['INBOUND_WORKER'],
      accountActive: true,
      requiredPermission: 'packing.execute',
      grantedPermissions: ['receiving.execute'], // does NOT include packing.execute
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('PERMISSION_DENIED');
  });

  it('Test 5 — Disabled worker + valid credentials → ACCOUNT_NOT_ACTIVE', () => {
    const d = evaluateAccess({
      application: 'WORKER_NATIVE',
      roles: ['INBOUND_WORKER'],
      accountActive: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('Test 6 — Revoked device + valid worker → DEVICE_NOT_AUTHORIZED', () => {
    const d = evaluateAccess({
      application: 'WORKER_NATIVE',
      roles: ['INBOUND_WORKER'],
      accountActive: true,
      stationId: 'RECEIVING-01',
      allowedStations: ['RECEIVING-01'],
      deviceAuthorized: false,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('DEVICE_NOT_AUTHORIZED');
  });

  it('Test 7 — Client claims role=ADMIN → ignored; server roles decide → denied', () => {
    // The API surface has NO client-role input: only server-derived roles reach
    // the decision. A worker whose server roles are operational is denied the
    // Admin Web even though a hostile client would love to claim ADMIN.
    const d = evaluateAccess({
      application: 'ADMIN_WEB',
      roles: ['INBOUND_WORKER'], // server-derived; client claim never arrives here
      accountActive: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('APPLICATION_NOT_ALLOWED_BY_ROLES');
  });

  it('Test 8 — Valid worker + device + station + permission → workflow accessible', () => {
    const d = evaluateAccess({
      application: 'WORKER_NATIVE',
      roles: ['INBOUND_WORKER'],
      accountActive: true,
      requiredPermission: 'receiving.execute',
      grantedPermissions: ['receiving.execute'],
      stationId: 'RECEIVING-01',
      allowedStations: ['RECEIVING-01'],
      deviceAuthorized: true,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('OK');
  });
});

describe('classifyRole / applicationsAllowedByRoles', () => {
  it('classifies seeded roles into the expected class', () => {
    expect(classifyRole('SUPER_ADMIN')).toBe('ADMIN');
    expect(classifyRole('WAREHOUSE_ADMIN')).toBe('ADMIN');
    expect(classifyRole('WAREHOUSE_MANAGER')).toBe('ADMIN');
    expect(classifyRole('INBOUND_WORKER')).toBe('OPERATIONAL');
    expect(classifyRole('PICKER')).toBe('OPERATIONAL');
    expect(classifyRole('PACKER')).toBe('OPERATIONAL');
    expect(classifyRole('VIEWER')).toBe('VIEWER');
    expect(classifyRole('SOMETHING_ELSE')).toBe('UNKNOWN');
  });

  it('admin-only → ADMIN_WEB; operational-only → WORKER_NATIVE', () => {
    expect(applicationsAllowedByRoles(['SUPER_ADMIN'])).toEqual(new Set(['ADMIN_WEB']));
    expect(applicationsAllowedByRoles(['INBOUND_WORKER'])).toEqual(new Set(['WORKER_NATIVE']));
  });

  it('multi-role (admin + operational) → explicit union of both apps', () => {
    expect(applicationsAllowedByRoles(['WAREHOUSE_MANAGER', 'PACKER'])).toEqual(
      new Set(['ADMIN_WEB', 'WORKER_NATIVE']),
    );
  });
});
