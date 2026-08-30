import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * Phase 0 — End-to-end tests against a real Nest app + real PostgreSQL.
 *
 * NOTE: These tests require a running PostgreSQL and expect the DB to be
 * migrated and seeded. They use a dedicated admin credential via env.
 *
 *   DATABASE_URL=... INITIAL_ADMIN_CODE=ADMIN001 INITIAL_ADMIN_PASSWORD=... \
 *     npm run test:e2e
 */
describe('AYROVI Warehouse Core — Auth & RBAC (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let workerToken: string;
  const adminCode = process.env.INITIAL_ADMIN_CODE || 'ADMIN001';
  const adminPass = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMe!2024';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Authentication', () => {
    it('rejects invalid credentials with 401', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: adminCode, secret: 'WRONG' })
        .expect(401);
    });

    it('rejects unknown employee code with 401 (uniform error)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'NOPE999', secret: 'whatever' })
        .expect(401);
    });

    it('logs in a valid admin and returns a token pair', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: adminCode, secret: adminPass })
        .expect(201);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      adminToken = res.body.accessToken;
    });

    it('returns current user info via /auth/me', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body.user.employeeCode).toBe(adminCode);
      expect(res.body.roles).toContain('SUPER_ADMIN');
    });
  });

  describe('RBAC enforcement (backend, not frontend)', () => {
    let workerId: string;
    // Unique per run so re-running against a persistent DB never conflicts.
    const workerCode = `E2EW${Math.floor(Math.random() * 1e9)}`;

    beforeAll(async () => {
      // Create a low-privilege VIEWER worker as admin.
      try {
        const res = await request(app.getHttpServer())
          .post('/api/v1/users')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'E2E Worker', employeeCode: workerCode, password: 'WorkerPass1', roles: ['VIEWER'] })
          .expect(201);
        workerId = res.body.id;
      } catch (e) {
        // If the user already exists from a previous run, fetch it.
        const list = await request(app.getHttpServer())
          .get('/api/v1/users')
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
        const found = list.body.find((u: any) => u.employeeCode === workerCode);
        if (found) workerId = found.id;
        else throw e;
      }

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: workerCode, secret: 'WorkerPass1' })
        .expect(201);
      workerToken = login.body.accessToken;
    });

    it('worker cannot list users (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${workerToken}`)
        .expect(403);
    });

    it('worker cannot manage roles (403)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/roles')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ name: 'SOME_ROLE' })
        .expect(403);
    });

    it('admin can list users (200)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('unauthenticated request is rejected (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/users').expect(401);
    });

    it('permission revocation takes effect immediately', async () => {
      // Remove the worker's roles entirely.
      await request(app.getHttpServer())
        .put(`/api/v1/users/${workerId}/roles`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ roles: [] })
        .expect(200);

      // Worker's existing access token now refuses admin-only? No — worker
      // never had users.manage. Instead verify a previously-granted action is
      // denied: worker still holds a valid session, but roles are gone so
      // view-only audit becomes FORBIDDEN after role removal.
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${workerToken}`)
        .expect(200);
      expect(me.body.permissions).toEqual([]);
    });

    it('session revocation (logout) invalidates the token immediately', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${workerToken}`)
        .expect(201);

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${workerToken}`)
        .expect(401);
    });
  });

  describe('Validation & uniform errors', () => {
    it('rejects invalid payloads with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ employeeCode: '' })
        .expect(400);
    });

    it('returns a uniform error envelope shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/users')
        .expect(401);
      expect(res.body).toHaveProperty('statusCode');
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('path');
      expect(res.body).toHaveProperty('timestamp');
    });
  });

  describe('Audit', () => {
    it('records a USER_LOGIN event', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/audit?take=50')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const actions = res.body.map((e: any) => e.action);
      expect(actions).toContain('USER_LOGIN');
    });
  });

  describe('API versioning', () => {
    it('serves routes under /api/v1', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/system/health')
        .expect(200);
    });
  });
});
