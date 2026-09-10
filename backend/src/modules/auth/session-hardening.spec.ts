import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';

/** Unit policy evidence; transactional rollback/concurrency must also run on PostgreSQL. */
describe('Session renewal hardening', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const current = {
      id: 'session', userId: 'worker', status: 'ACTIVE', application: 'WORKER_NATIVE',
      refreshTokenHash: 'hash:refresh', expiresAt: new Date(Date.now() + 60000),
      user: { id: 'worker', status: 'ACTIVE' }, deviceId: 'device', stationId: 'station',
      device: { id: 'device', status: 'ACTIVE', assignedWorkerId: 'worker' },
      station: { id: 'station', status: 'ACTIVE', assignedWorkerId: 'worker' }, ...overrides,
    };
    let consumed = false;
    const db: any = {
      session: {
        findUnique: jest.fn(async () => ({ ...current })),
        updateMany: jest.fn(async () => { if (consumed) return { count: 0 }; consumed = true; return { count: 1 }; }),
        create: jest.fn(async ({ data }) => data),
      },
      userRole: { findMany: jest.fn(async () => [{ role: { name: 'RECEIVING_WORKER', applicationClass: 'OPERATIONAL' } }]) },
    };
    db.$transaction = jest.fn((body) => body(db));
    const tokens: any = {
      verifyRefreshToken: jest.fn(() => ({ sid: 'session', sub: 'worker', app: 'WORKER_NATIVE', type: 'refresh' })),
      hashToken: jest.fn((token) => `hash:${token}`),
      signAccessToken: jest.fn(() => 'new-access'),
      signRefreshToken: jest.fn(() => ({ token: 'new-refresh', expiresAt: new Date(Date.now() + 60000) })),
    };
    return { service: new AuthService(db, tokens, { log: jest.fn() } as any, new LoginThrottleService()), db, tokens };
  }
  it('rotates only the matching stored refresh token and keeps server device/station bindings', async () => {
    const { service, db } = setup();
    expect(await service.refresh('refresh')).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(db.session.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'session', status: 'ACTIVE', refreshTokenHash: 'hash:refresh' });
    expect(db.session.create.mock.calls[0][0].data).toMatchObject({ userId: 'worker', deviceId: 'device', stationId: 'station', refreshTokenHash: 'hash:new-refresh' });
    expect(db.session.create.mock.calls[0][0].data.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([
    { refreshTokenHash: 'other-hash' }, { status: 'REVOKED' }, { userId: 'other-worker' },
    { application: 'ADMIN_WEB' }, { expiresAt: new Date(0) }, { user: { status: 'DISABLED' } },
    { device: { status: 'DISABLED' } }, { device: { status: 'ACTIVE', assignedWorkerId: 'other-worker' } },
    { station: { status: 'ACTIVE', assignedWorkerId: 'other-worker' } },
  ])('rejects stale or changed authentication context %p', async (change) => {
    const { service, db } = setup(change);
    await expect(service.refresh('refresh')).rejects.toThrow(UnauthorizedException);
    expect(db.session.create).not.toHaveBeenCalled();
  });
  it('checks current application class on refresh', async () => {
    const { service, db } = setup();
    db.userRole.findMany.mockResolvedValue([{ role: { name: 'VIEWER', applicationClass: 'VIEWER' } }]);
    await expect(service.refresh('refresh')).rejects.toThrow(UnauthorizedException);
  });
  it('allows one compare-and-set winner for concurrent refresh attempts', async () => {
    const { service, db } = setup();
    const results = await Promise.allSettled([service.refresh('refresh'), service.refresh('refresh')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.session.create).toHaveBeenCalledTimes(1);
  });
});
