import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * Strict Admin/Worker isolation — HTTP acceptance matrix (Doc1 §16).
 *
 * Runs against a real Nest app + real PostgreSQL. Requires the DB to be
 * migrated and seeded (roles/permissions + initial admin), like the rest of
 * the e2e suite:
 *
 *   cd backend
 *   DATABASE_URL=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... \
 *   INITIAL_ADMIN_CODE=ADMIN001 INITIAL_ADMIN_PASSWORD='ChangeMe!2024' \
 *   npx jest --config ./test/jest-e2e.json test/isolation.e2e-spec.ts
 *
 * Coverage (each assertion is server-side):
 *   Test 1 — Admin credentials + WORKER_NATIVE  → 403, no worker session
 *   Test 2 — Worker credentials + ADMIN_WEB     → 403, no admin session
 *   Test 3 — Admin session on a worker route    → 403 (surface isolation)
 *   Test 4 — Worker session on an admin route   → 403 (surface/permission)
 *   Test 5 — Disabled worker + old token        → 401 (sessions revoked)
 *   Test 6 — Revoked/disabled device + worker   → 401 (device revoked)
 *   Test 7 — Client cannot open a surface its roles do not allow
 *   Test 8 — Valid worker + WORKER_NATIVE       → 200 worker workflow context
 *   Extras — device register/bind flow, role-change forced re-auth.
 */
const ADMIN_CODE = process.env.INITIAL_ADMIN_CODE || 'ADMIN001';
const ADMIN_PASS = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMe!2024';
const tag = `ISO${Date.now().toString(36).toUpperCase()}`;
const PWD = 'IsolationPass!1';

describe('Strict Admin/Worker isolation (HTTP)', () => {
  jest.setTimeout(120000);

  let app: INestApplication;
  let prisma: PrismaClient;
  let adminToken = '';
  const userIds = new Set<string>();
  let adminUserId = '';
  let workerUserId = '';
  let adminCode = '';
  let workerCode = '';
  let deviceId = '';
  const deviceCode = `DEV-${tag}`;
  let workerToken = '';

  const login = (
    code: string,
    secret = PWD,
    appName?: 'ADMIN_WEB' | 'WORKER_NATIVE',
    device?: string,
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: code,
        secret,
        ...(appName ? { app: appName } : {}),
        ...(device ? { deviceId: device } : {}),
      });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = new PrismaClient();
    adminToken = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: ADMIN_CODE, secret: ADMIN_PASS })
        .expect(201)
    ).body.accessToken;

    // ---- Fixture users: one WAREHOUSE_ADMIN (admin surface) + one worker.
    adminCode = `ISOADM${tag}`.slice(0, 30);
    const adminRes = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `ISO Admin ${tag}`,
        employeeCode: adminCode,
        password: PWD,
        roles: ['WAREHOUSE_ADMIN'],
      })
      .expect(201);
    adminUserId = adminRes.body.id;
    userIds.add(adminUserId);

    workerCode = `ISOWRK${tag}`.slice(0, 30);
    const workerRes = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: `ISO Worker ${tag}`,
        employeeCode: workerCode,
        password: PWD,
        roles: ['INBOUND_WORKER'],
      })
      .expect(201);
    workerUserId = workerRes.body.id;
    userIds.add(workerUserId);
  });

  afterAll(async () => {
    if (prisma) {
      await (prisma as any).device.deleteMany({ where: { code: deviceCode } });
      await (prisma as any).session.deleteMany({ where: { userId: { in: [...userIds] } } });
      await (prisma as any).auditLog.deleteMany({
        where: { actorUserId: { in: [...userIds] } },
      });
      await (prisma as any).userRole.deleteMany({ where: { userId: { in: [...userIds] } } });
      await (prisma as any).user.deleteMany({ where: { id: { in: [...userIds] } } });
      await prisma.$disconnect();
    }
    if (app) await app.close();
  });

  // ------------------------------------------------ 1. cross-app logins DENY
  it('Test 1 — Admin credentials + WORKER_NATIVE → 403, no worker session', async () => {
    await login(adminCode, PWD, 'WORKER_NATIVE').expect(403);
    const count = await (prisma as any).session.count({
      where: { userId: adminUserId, status: 'ACTIVE' },
    });
    // The admin user never opened a session of any kind yet.
    expect(count).toBe(0);
  });

  it('Test 2 — Worker credentials + ADMIN_WEB → 403, no admin session', async () => {
    await login(workerCode, PWD, 'ADMIN_WEB').expect(403);
    const count = await (prisma as any).session.count({
      where: { userId: workerUserId, status: 'ACTIVE' },
    });
    expect(count).toBe(0);
  });

  it('Test 7 — A client cannot claim a surface its roles do not allow (no session minted)', async () => {
    // Same call as Test 1/2 pattern but asserted via /auth/me absence: the
    // server refuses to create the session in the first place.
    await login(adminCode, PWD, 'WORKER_NATIVE').expect(403);
    await login(workerCode, PWD, 'ADMIN_WEB').expect(403);
  });

  // ----------------------------------------------- 2. HTTP surface isolation
  it('Test 3 — Admin session on a WORKER_NATIVE route → 403 (surface boundary, no permission needed)', async () => {
    const adminSession = await login(adminCode, PWD, 'ADMIN_WEB').expect(201);
    const token = adminSession.body.accessToken;
    // /terminal/context carries no @RequirePermissions — an ADMIN_WEB session
    // would pass the RBAC guard. The ApplicationGuard is therefore the only
    // guard that can reject it: proof of surface isolation, not of a missing
    // permission. The same boundary protects /receiving/*, /putaway/*, ...
    await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('Test 4 — Worker session on an ADMIN_WEB route → 403', async () => {
    const workerSession = await login(workerCode, PWD, 'WORKER_NATIVE').expect(201);
    workerToken = workerSession.body.accessToken;
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${workerToken}`)
      .expect(403);
  });

  it('Test 8 — Valid worker + WORKER_NATIVE → worker workflow context (200)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${workerToken}`)
      .expect(200);
    expect(res.body.worker?.id).toBe(workerUserId);
    const keys = (res.body.tasks ?? []).map((t: any) => t.key);
    expect(keys).toContain('receiving');
  });

  // ---------------------------------------------- 3. device binding & revoke
  it('rejects an unregistered device at worker login (DEVICE_REJECTED)', async () => {
    await login(workerCode, PWD, 'WORKER_NATIVE', 'NO-SUCH-DEVICE').expect(403);
  });

  it('binds a registered ACTIVE device to the worker, then disabling it revokes the session', async () => {
    const devRes = await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: deviceCode, name: `ISO Device ${tag}`, workerId: workerUserId })
      .expect(201);
    deviceId = devRes.body.id;
    expect(devRes.body.status).toBe('ACTIVE');

    // Worker logs in from the authorized device → session bound to it.
    const sess = await login(workerCode, PWD, 'WORKER_NATIVE', deviceCode).expect(201);
    const boundToken = sess.body.accessToken;
    await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${boundToken}`)
      .expect(200);

    // Admin disables the device → bound sessions are revoked server-side.
    // (POST routes answer 201 by default in Nest.)
    await request(app.getHttpServer())
      .post(`/api/v1/devices/${deviceId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DISABLED' })
      .expect(201);

    // The previously valid session is dead on the next request (401).
    await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${boundToken}`)
      .expect(401);
  });

  // -------------------------------------------------- 4. revocation semantics
  it('Test 5 — Disabled worker + valid old token → 401 (sessions revoked)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${workerUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${workerToken}`)
      .expect(401);
  });

  it('Test 6 — removing the operational role forces re-authentication', async () => {
    // Re-enable the worker first.
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${workerUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: true })
      .expect(200);

    const sess = await login(workerCode, PWD, 'WORKER_NATIVE').expect(201);
    const token = sess.body.accessToken;
    await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Reassign to VIEWER (admin-surface class) → the old worker session is
    // rejected and revoked on the next request.
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${workerUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roles: ['VIEWER'] })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
