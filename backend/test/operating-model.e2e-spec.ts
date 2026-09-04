import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
// Service-level harness (same style as operational-flow.e2e-spec.ts).
import { ExpectedArrivalsService } from '../src/modules/expected-arrivals/expected-arrivals.service';
import { ReceivingService } from '../src/modules/receiving/receiving.service';
import { FulfillmentService } from '../src/modules/fulfillment/fulfillment.service';
import { CategoriesService } from '../src/modules/categories/categories.service';

/**
 * PARTIE 2 — WORKFORCE OPERATING MODEL (model verification only).
 *
 * Pins the operating model documented in
 * `docs/WORKFORCE-OPERATING-MODEL-P2.md` against a real Nest app + real
 * PostgreSQL (HTTP) and real services (receiving/fulfillment chain):
 *
 *   1. role → permission matrix integrity (workers never carry admin grants)
 *   2. worker task access: /terminal/context shows ONLY the tasks a role may
 *      run — and records the actual (superset) behaviour for INBOUND_WORKER
 *   3. workers cannot reach admin endpoints (403) or manage other workers
 *   4. station assignment: assigned station is served to the worker's
 *      terminal context and removed when the admin clears it
 *   5. worker-task lifecycle (Command #3 layering): OPEN → DONE self-scoped,
 *      another worker can neither see nor complete someone else's task
 *   6. container capacity is configuration, not a code constant
 *      (custom capacity persisted; default 50 used only when not provided)
 *   7. a missing/unconfirmed CATEGORY does NOT block article receiving and
 *      the article still lands in the receiving tote (NEEDS_REVIEW, not a stop)
 *
 * Run:  cd backend && DATABASE_URL=... JWT_ACCESS_SECRET=... JWT_REFRESH_SECRET=... \
 *        INITIAL_ADMIN_CODE=ADMIN001 INITIAL_ADMIN_PASSWORD='ChangeMe!2024' npm run test:e2e
 */
const ADMIN_CODE = process.env.INITIAL_ADMIN_CODE || 'ADMIN001';
const ADMIN_PASS = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMe!2024';
const tag = `P2OM${Date.now().toString(36).toUpperCase()}`;

// Permissions that must NEVER appear on a floor (worker) role.
const ADMIN_ONLY_KEYS = [
  'users.manage', 'roles.manage', 'system.manage', 'api_clients.manage',
  'operations.correct', 'inventory.manage', 'stations.manage', 'warehouse_orders.cancel',
  'order_items.cancel', 'physical_items.cancel',
];

describe('PARTIE 2 — Workforce Operating Model', () => {
  jest.setTimeout(120000);

  // ---------------------------------------------------------------- HTTP app
  let app: INestApplication;
  let adminToken = '';
  let prisma: PrismaClient;

  // fixture users
  const codes = {
    inbound: `P2OM${tag}-INB`,
    picker: `P2OM${tag}-PCK`,
    packer: `P2OM${tag}-PCK2`,
    viewer: `P2OM${tag}-VW`,
  } as Record<string, string>;
  const userIds = new Set<string>();
  const tokens: Record<string, string> = {};

  const login = (code: string, secret = 'WorkerPass!1', appName?: 'ADMIN_WEB' | 'WORKER_NATIVE') =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ identifier: code, secret, ...(appName ? { app: appName } : {}) })
      .expect(201)
      .then((r) => r.body.accessToken as string);

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
    adminToken = await login(ADMIN_CODE, ADMIN_PASS);

    // Create one real user per operating role through the real Admin API.
    const roleByCode: Record<string, string> = {
      inbound: 'INBOUND_WORKER', picker: 'PICKER', packer: 'PACKER', viewer: 'VIEWER',
    };
    for (const [k, code] of Object.entries(codes)) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `P2 ${k}`, employeeCode: code, password: 'WorkerPass!1', roles: [roleByCode[k]] })
        .expect(201);
      userIds.add(res.body.id);
      // Floor roles open WORKER_NATIVE sessions (strict isolation): these
      // tokens are used against /terminal/* worker routes below.
      tokens[k] = await login(code, 'WorkerPass!1', 'WORKER_NATIVE');
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) {
      // Restore station ST-REC-02 to unassigned.
      await (prisma as any).station.updateMany({
        where: { code: 'ST-REC-02' }, data: { assignedWorkerId: null },
      });
      // Scoped cleanup of this suite's fixtures (users, assignments, audits).
      await (prisma as any).auditLog.deleteMany({
        where: { action: { in: ['TASK_ASSIGNED', 'TASK_COMPLETED'] }, actorUserId: { in: [...userIds] } },
      });
      await (prisma as any).workerTaskAssignment.deleteMany({
        where: { workerId: { in: [...userIds] } },
      });
      await (prisma as any).userRole.deleteMany({ where: { userId: { in: [...userIds] } } });
      await (prisma as any).user.deleteMany({ where: { id: { in: [...userIds] } } });
      await prisma.$disconnect();
    }
  });

  // --------------------------------------------------- 1. role→permission map
  it('role→permission matrix: floor roles never carry admin grants; each task execute key maps to its operating role', async () => {
    const rows: any[] = await (prisma as any).rolePermission.findMany({
      include: { role: true, permission: true },
    });
    const byRole: Record<string, Set<string>> = {};
    for (const rp of rows) {
      (byRole[rp.role.name] ??= new Set<string>()).add(rp.permission.key);
    }
    // Operating roles + the execute permission they must expose (doc §8).
    const expects: Record<string, string> = {
      INBOUND_WORKER: 'receiving.execute',
      PICKER: 'picking.execute', // drives Order Sorting = customer sorting today
      PACKER: 'packing.execute',
    };
    for (const [role, key] of Object.entries(expects)) {
      expect(byRole[role]?.has(key)).toBe(true);
    }
    // Workers carry zero admin-only grants.
    for (const role of ['INBOUND_WORKER', 'PICKER', 'PACKER', 'VIEWER']) {
      const grants = byRole[role] ?? new Set<string>();
      const leaks = ADMIN_ONLY_KEYS.filter((k) => grants.has(k));
      expect(leaks).toEqual([]);
    }
    // VIEWER has no execute at all (read-only monitor).
    const viewerGrants = byRole.VIEWER ?? new Set<string>();
    expect([...viewerGrants].filter((k) => k.endsWith('.execute') || k.endsWith('.manage'))).toEqual([]);
  });

  // ---------------------------------------------- 2. worker task access (RBAC)
  it('terminal context shows only tasks the role may run (and pins INBOUND = receiving + stowing superset)', async () => {
    const ctx = async (code: string) =>
      (await request(app.getHttpServer())
        .get('/api/v1/terminal/context')
        .set('Authorization', `Bearer ${tokens[code]}`)
        .expect(200)).body;
    const keys = async (code: string) => (await ctx(code)).tasks.map((t: any) => t.key);

    const inbound = await keys('inbound');
    expect(inbound).toContain('receiving');
    // Documented current behaviour (doc §8/C1): INBOUND_WORKER also holds
    // stowing.execute so Sorting + Putaway are visible. This pins the superset
    // so a future permission/role change is caught, not silently drifted.
    expect(inbound).toContain('sorting');
    expect(inbound).toContain('putaway');

    expect(await keys('picker')).toEqual(['order-sorting']);
    expect(await keys('packer')).toEqual(['packing']);
    expect(await keys('viewer')).toEqual([]);

    // No cross-task leak: inbound has no packing/picking/shipping, etc.
    for (const forbidden of ['packing', 'order-sorting', 'shipping']) {
      expect(inbound).not.toContain(forbidden);
    }
  });

  // ----------------------------------------------------- 3. worker ≠ admin
  it('workers cannot reach admin surfaces or manage other workers (403)', async () => {
    const worker = tokens.inbound;
    await request(app.getHttpServer())
      .get('/api/v1/operations/workers').set('Authorization', `Bearer ${worker}`).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/users').set('Authorization', `Bearer ${worker}`).expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/operations/workers/${'00000000-0000-0000-0000-000000000000'}/block`)
      .set('Authorization', `Bearer ${worker}`)
      .send({})
      .expect(403);
    // Floor packing permission does not grant shipping either.
    await request(app.getHttpServer())
      .get('/api/v1/fulfillment/outbound-shipments')
      .set('Authorization', `Bearer ${tokens.packer}`)
      .expect(403);
  });

  // ------------------------------------------------- 4. station assignment
  it('station assignment: the assigned station is served to the worker terminal and cleared by the admin', async () => {
    const station = await (prisma as any).station.findUnique({ where: { code: 'ST-REC-02' } });
    expect(station).toBeTruthy();

    // Admin assigns the inbound worker to ST-REC-02.
    await request(app.getHttpServer())
      .post(`/api/v1/stations/${station.id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ workerId: [...userIds][0] })
      .expect(201);
    let ctx = (await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${tokens.inbound}`)
      .expect(200)).body;
    expect(ctx.station?.code).toBe('ST-REC-02');

    // Admin clears the assignment -> terminal no longer shows a station.
    await request(app.getHttpServer())
      .post(`/api/v1/stations/${station.id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ workerId: null })
      .expect(201);
    ctx = (await request(app.getHttpServer())
      .get('/api/v1/terminal/context')
      .set('Authorization', `Bearer ${tokens.inbound}`)
      .expect(200)).body;
    expect(ctx.station).toBeNull();
  });

  // --------------------------------- 5. worker-task lifecycle (Command #3 layer)
  it('assigned-task lifecycle is self-scoped: owner completes, others cannot see or complete it', async () => {
    const title = `P2OM task ${tag}`;
    const created = (await request(app.getHttpServer())
      .post('/api/v1/operations/worker-tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ workerId: [...userIds][0], title, description: 'operating-model check' })
      .expect(201)).body;
    expect(created.status).toBe('OPEN');

    // Owner sees it as OPEN.
    let mine = (await request(app.getHttpServer())
      .get('/api/v1/terminal/assignments')
      .set('Authorization', `Bearer ${tokens.inbound}`)
      .expect(200)).body;
    expect(mine.open.map((a: any) => a.title)).toContain(title);

    // The picker (another worker) neither sees it nor may complete it.
    const other = (await request(app.getHttpServer())
      .get('/api/v1/terminal/assignments')
      .set('Authorization', `Bearer ${tokens.picker}`)
      .expect(200)).body;
    expect(other.open.map((a: any) => a.title)).not.toContain(title);
    await request(app.getHttpServer())
      .post(`/api/v1/terminal/assignments/${created.id}/complete`)
      .set('Authorization', `Bearer ${tokens.picker}`)
      .send({})
      .expect(404);

    // Owner completes it -> DONE, and the admin registry reflects it.
    await request(app.getHttpServer())
      .post(`/api/v1/terminal/assignments/${created.id}/complete`)
      .set('Authorization', `Bearer ${tokens.inbound}`)
      .send({ note: 'verified during Partie 2' })
      .expect(201);
    mine = (await request(app.getHttpServer())
      .get('/api/v1/terminal/assignments')
      .set('Authorization', `Bearer ${tokens.inbound}`)
      .expect(200)).body;
    expect(mine.open.map((a: any) => a.title)).not.toContain(title);
    const registry = (await request(app.getHttpServer())
      .get('/api/v1/operations/worker-tasks')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)).body;
    const row = registry.find((r: any) => r.id === created.id);
    expect(row?.status).toBe('DONE');
    expect(row?.note).toContain('verified during Partie 2');
  });

  // ------------------------------------ 6. container capacity = configuration
  it('container capacity is configuration: custom capacity is honoured, default is 50', async () => {
    const prismaSvc = prisma;
    const noAudit = { log: async () => {} } as any;
    const categories = new CategoriesService(prisma as any, noAudit);
    const fulfillment = new FulfillmentService(prisma as any, noAudit, categories);
    const actor = { id: `p2-${tag}`, name: 'P2', ip: null } as any;

    const custom = await fulfillment.createContainer({ type: 'RECEIVING', capacity: 3 }, actor);
    const customRow = await (prismaSvc as any).operationalContainer.findUnique({ where: { code: custom.code } });
    expect(customRow.capacity).toBe(3);

    const dflt = await fulfillment.createContainer({ type: 'RECEIVING' }, actor);
    const dfltRow = await (prismaSvc as any).operationalContainer.findUnique({ where: { code: dflt.code } });
    expect(dfltRow.capacity).toBe(50);

    // a nonsense capacity is rejected by validation
    await expect(
      fulfillment.createContainer({ type: 'RECEIVING', capacity: -1 } as any, actor),
    ).rejects.toThrow(/capacity/);

    await (prismaSvc as any).operationalContainer.deleteMany({
      where: { code: { in: [custom.code, dflt.code] } },
    });
  });

  // ----------------------- 7. category missing never blocks receiving → tote
  it('missing category does NOT block an article from reaching the receiving tote', async () => {
    const prismaSvc = prisma;
    const noAudit = { log: async () => {} } as any;
    const arrivals = new ExpectedArrivalsService(prisma as any, noAudit);
    const receiving = new ReceivingService(prisma as any, noAudit);
    const categories = new CategoriesService(prisma as any, noAudit);
    const fulfillment = new FulfillmentService(prisma as any, noAudit, categories);
    const principal = { kind: 'static' as const, id: null, name: 'e2e-p2', idempotencyKey: null };
    const sku = `P2SKU-${tag}`;
    const cardId = `card:${tag}:nocate`;
    const actor = { id: `p2w-${tag}`, name: 'P2 worker', canResolveDiscrepancy: true, ip: null } as any;

    // CRM card for the SKU WITHOUT any category (product info missing).
    const res = await arrivals.receiveCard(
      {
        event: 'customer_arrival_card.created',
        arrival: { id: `ARR-${tag}-NC`, reference: null },
        customer_arrival_card: {
          id: cardId,
          customer: { id: `cust-${tag}`, name: 'NoCat Customer' },
          store: { id: 'STORE-P2', name: 'P2' },
          products: [{ sku, product_name: 'Unclassified Article', quantity: 1 }],
        },
      } as any,
      principal,
    );
    expect(res.created).toBe(true);

    const arrivalRow = await (prismaSvc as any).expectedArrival.findUnique({
      where: { customerArrivalCardId: cardId },
    });
    const session = await receiving.start(arrivalRow.id, actor);
    const tote = await fulfillment.createContainer({ type: 'RECEIVING' }, actor);

    // The article scan must succeed (no category needed) and land in the tote.
    const scan = await fulfillment.scanArticleAtReceiving(
      session.id, { sku, containerCode: tote.code }, actor,
    );
    expect(scan.matched).toBe(true);
    expect(scan.flash.kind).toBe('ARTICLE_RECEIVED');
    const unit = await (prismaSvc as any).articleUnit.findUnique({
      where: { code: scan.flash.article.code },
    });
    expect(unit.status).toBe('IN_CONTAINER');
    expect(unit.containerId).toBe(tote.id);
    expect(unit.category).toBeNull();
    expect(unit.categoryStatus).toBe('NEEDS_REVIEW'); // honest UNKNOWN, never a stop

    // Cleanup (scoped to this suite only).
    await (prismaSvc as any).articleUnit.deleteMany({ where: { code: scan.flash.article.code } });
    await (prismaSvc as any).receivingDiscrepancy.deleteMany({ where: { session: { id: session.id } } });
    await (prismaSvc as any).receivingCarton.deleteMany({ where: { session: { id: session.id } } });
    await (prismaSvc as any).receivingProduct.deleteMany({ where: { session: { id: session.id } } });
    await (prismaSvc as any).receivingSession.deleteMany({ where: { id: session.id } });
    await (prismaSvc as any).operationalContainer.deleteMany({ where: { code: tote.code } });
    await (prismaSvc as any).expectedArrivalItem.deleteMany({ where: { arrival: { customerArrivalCardId: cardId } } });
    await (prismaSvc as any).expectedArrival.deleteMany({ where: { customerArrivalCardId: cardId } });
  });
});
