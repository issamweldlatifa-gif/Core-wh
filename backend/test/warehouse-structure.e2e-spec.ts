import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * Phase 1 — End-to-end tests for the physical warehouse structure.
 *
 * Requires a running PostgreSQL, migrated and seeded:
 *   DATABASE_URL=... INITIAL_ADMIN_CODE=ADMIN001 INITIAL_ADMIN_PASSWORD=... \
 *     npm run test:e2e
 *
 * Covers the section-35 acceptance list: Warehouse/Zone/Aisle/Rack/Level/
 * Location CRUD, duplicate rejection scoped per parent, invalid parent
 * hierarchy rejection, deactivation, RBAC (401/403), multi-warehouse
 * isolation, and audit-event emission.
 */
describe('AYROVI Warehouse Core — Physical Structure (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let managerToken: string;
  let viewerToken: string;
  const adminCode = process.env.INITIAL_ADMIN_CODE || 'ADMIN001';
  const adminPass = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMe!2024';

  // Unique per-run business codes so a persistent DB never conflicts.
  const W_CODE = `WH-${Math.floor(Math.random() * 1e6)}`;
  const W_CODE2 = `WH-${Math.floor(Math.random() * 1e6)}`;

  let warehouseId: string;
  let warehouse2Id: string;
  let zoneId: string;
  let aisleId: string;
  let rackId: string;
  let levelId: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const loginAs = async (identifier: string, secret: string) => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier, secret })
      .expect(201);
    return res.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    adminToken = await loginAs(adminCode, adminPass);

    // A VIEWER worker (read-only) and a WAREHOUSE_MANAGER (no create).
    const viewerCode = `E2EV${Math.floor(Math.random() * 1e9)}`;
    const managerCode = `E2EM${Math.floor(Math.random() * 1e9)}`;
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(auth(adminToken))
      .send({ name: 'E2E Viewer', employeeCode: viewerCode, password: 'Passw0rd1!', roles: ['VIEWER'] })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set(auth(adminToken))
      .send({ name: 'E2E Manager', employeeCode: managerCode, password: 'Passw0rd1!', roles: ['WAREHOUSE_MANAGER'] })
      .expect(201);
    viewerToken = await loginAs(viewerCode, 'Passw0rd1!');
    managerToken = await loginAs(managerCode, 'Passw0rd1!');
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  describe('Warehouse', () => {
    it('creates a warehouse (WAREHOUSE_CREATED audit)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: W_CODE, name: 'Test Warehouse A' })
        .expect(201);
      expect(res.body.code).toBe(W_CODE);
      expect(res.body.status).toBe('ACTIVE');
      warehouseId = res.body.id;

      const audit = await request(app.getHttpServer())
        .get('/api/v1/audit?take=100')
        .set(auth(adminToken))
        .expect(200);
      expect(audit.body.map((e: any) => e.action)).toContain('WAREHOUSE_CREATED');
    });

    it('rejects a duplicate warehouse code (409)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: W_CODE, name: 'Dup' })
        .expect(409);
    });

    it('deactivates and reactivates a warehouse', async () => {
      await request(app.getHttpServer()).post(`/api/v1/warehouses/${warehouseId}/deactivate`).set(auth(adminToken)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/warehouses/${warehouseId}/activate`).set(auth(adminToken)).expect(201);
    });

    it('creates a second warehouse for isolation tests', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: W_CODE2, name: 'Test Warehouse B' })
        .expect(201);
      warehouse2Id = res.body.id;
    });
  });

  describe('Zone', () => {
    it('creates a zone', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/zones')
        .set(auth(adminToken))
        .send({ warehouseId, code: 'SHOES', name: 'Shoes' })
        .expect(201);
      expect(res.body.code).toBe('SHOES');
      zoneId = res.body.id;
    });

    it('rejects a duplicate zone code within the SAME warehouse', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/zones')
        .set(auth(adminToken))
        .send({ warehouseId, code: 'SHOES', name: 'Dup' })
        .expect(409);
    });

    it('ALLOWS the same zone code in a DIFFERENT warehouse', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/zones')
        .set(auth(adminToken))
        .send({ warehouseId: warehouse2Id, code: 'SHOES', name: 'Shoes B' })
        .expect(201);
    });
  });

  describe('Aisle / Rack / Level', () => {
    it('creates an aisle, rack and level in sequence', async () => {
      const aisle = await request(app.getHttpServer()).post('/api/v1/aisles').set(auth(adminToken)).send({ zoneId, code: 'A01', name: 'Aisle 1' }).expect(201);
      aisleId = aisle.body.id;
      const rack = await request(app.getHttpServer()).post('/api/v1/racks').set(auth(adminToken)).send({ aisleId, code: 'R01', name: 'Rack 1' }).expect(201);
      rackId = rack.body.id;
      // D-36: code auto-derived from levelNumber (3 -> L03).
      const level = await request(app.getHttpServer()).post('/api/v1/levels').set(auth(adminToken)).send({ rackId, levelNumber: 3 }).expect(201);
      expect(level.body.code).toBe('L03');
      expect(level.body.levelNumber).toBe(3);
      levelId = level.body.id;
    });

    it('rejects a duplicate aisle code within the same zone', async () => {
      await request(app.getHttpServer()).post('/api/v1/aisles').set(auth(adminToken)).send({ zoneId, code: 'A01', name: 'Dup' }).expect(409);
    });
  });

  describe('Location', () => {
    it('creates a location and derives the code from the parent chain (D-30/D-33)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/locations')
        .set(auth(adminToken))
        .send({ warehouseId, zoneId, aisleId, rackId, levelId, locationType: 'STORAGE', maxUnits: 10 })
        .expect(201);
      expect(res.body.locationCode).toBe(`${W_CODE}-SHOES-A01-R01-L03`);
      expect(res.body.barcodeValue).toBe(`${W_CODE}-SHOES-A01-R01-L03`); // D-33
      expect(res.body.locationType).toBe('STORAGE');
      expect(res.body.maxUnits).toBe(10);
    });

    it('rejects a mismatched parent hierarchy (zone from another warehouse)', async () => {
      const otherZone = await request(app.getHttpServer())
        .get(`/api/v1/zones?warehouseId=${warehouse2Id}`)
        .set(auth(adminToken))
        .expect(200);
      const otherZoneId = otherZone.body[0].id;
      const res = await request(app.getHttpServer())
        .post('/api/v1/locations')
        .set(auth(adminToken))
        .send({ warehouseId, zoneId: otherZoneId, aisleId, rackId, levelId, locationType: 'STORAGE' })
        .expect(400);
      expect(res.body.message).toContain('Invalid parent hierarchy');
    });

    it('deactivates a location (LOCATION_DEACTIVATED)', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/locations?warehouseId=' + warehouseId).set(auth(adminToken)).expect(200);
      const locId = list.body.items[0].id;
      await request(app.getHttpServer()).post(`/api/v1/locations/${locId}/deactivate`).set(auth(adminToken)).expect(201);
      const audit = await request(app.getHttpServer()).get('/api/v1/audit?take=100').set(auth(adminToken)).expect(200);
      expect(audit.body.map((e: any) => e.action)).toContain('LOCATION_DEACTIVATED');
    });

    it('supports search and filtering', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/locations/search?q=${W_CODE}`).set(auth(adminToken)).expect(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Multi-warehouse isolation', () => {
    it('never crosses warehouse scope: warehouse A locations do not include B', async () => {
      // Warehouse A: create a location only in A's structure.
      const res = await request(app.getHttpServer())
        .get(`/api/v1/locations?warehouseId=${warehouseId}`)
        .set(auth(adminToken))
        .expect(200);
      const codesA = res.body.items.map((l: any) => l.locationCode);
      const resB = await request(app.getHttpServer())
        .get(`/api/v1/locations?warehouseId=${warehouse2Id}`)
        .set(auth(adminToken))
        .expect(200);
      const codesB = resB.body.items.map((l: any) => l.locationCode);
      // All A codes belong to A's warehouse, none should equal any B code.
      for (const c of codesA) expect(c.startsWith(W_CODE + '-')).toBe(true);
      for (const c of codesB) expect(c.startsWith(W_CODE2 + '-')).toBe(true);
      // No location code may appear under the wrong warehouse prefix.
      expect(codesA.some((c: string) => c.startsWith(W_CODE2 + '-'))).toBe(false);
      expect(codesB.some((c: string) => c.startsWith(W_CODE + '-'))).toBe(false);
    });
  });

  describe('RBAC', () => {
    it('rejects unauthenticated access (401)', async () => {
      await request(app.getHttpServer()).get('/api/v1/warehouses').expect(401);
    });

    it('VIEWER can list but cannot create (403)', async () => {
      await request(app.getHttpServer()).get('/api/v1/locations').set(auth(viewerToken)).expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set(auth(viewerToken))
        .send({ code: 'NOPE', name: 'x' })
        .expect(403);
    });

    it('WAREHOUSE_MANAGER has NO create permission (403) but can update/deactivate (D-34)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/zones')
        .set(auth(managerToken))
        .send({ warehouseId, code: 'NOZONE', name: 'x' })
        .expect(403);
      // Activate/deactivate uses the deactivate/activate permission it has.
      await request(app.getHttpServer()).post(`/api/v1/warehouses/${warehouseId}/deactivate`).set(auth(managerToken)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/warehouses/${warehouseId}/activate`).set(auth(managerToken)).expect(201);
    });
  });
});
