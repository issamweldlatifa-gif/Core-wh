import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcrypt';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';

/** Real PostgreSQL + HTTP exercise of EXISTING operations. Missing automatic hand-off is reported BLOCKED, never claimed passed. */
describe('Isolated 90-unit operational validation', () => {
  jest.setTimeout(180000);
  const tag = `WV${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const integrationKey = `Isolated-${randomUUID()}`;
  const previousIntegrationKey = process.env.WAREHOUSE_INTEGRATION_API_KEY;
  const password = `TestOnly-${randomUUID()}`;
  const prisma = new PrismaClient();
  let app: INestApplication;
  let arrival: any; let warehouse: any; let location: any; let category: any;
  let sessionId = '';
  const people: any[] = []; const roleIds: string[] = []; const deviceIds: string[] = []; const stationIds: string[] = [];
  const tokens: Record<string, string> = {};
  const cartons: string[] = []; const totes: string[] = []; const articles: Array<{ code: string; sku: string }> = [];
  const bins: string[] = []; const orders: string[] = []; const observations: Record<string, unknown> = {};
  const sku = (n: number) => `${tag}-SKU-${n}`;
  const api = (who: string, method: 'get' | 'post', path: string, body?: object) => {
    const call = request(app.getHttpServer())[method](`/api/v1${path}`).set('Authorization', `Bearer ${tokens[who]}`);
    return body === undefined ? call : call.send(body);
  };
  beforeAll(async () => {
    if (process.env.AYROVI_TEST_DATABASE !== 'true') throw new Error('Refusing fixture execution: an explicitly isolated test database is required.');
    process.env.WAREHOUSE_INTEGRATION_API_KEY = integrationKey;
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    tokens.admin = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({
      identifier: process.env.INITIAL_ADMIN_CODE, secret: process.env.INITIAL_ADMIN_PASSWORD,
    }).expect(201)).body.accessToken;
    warehouse = await prisma.warehouse.create({ data: { code: tag, name: 'ISOLATED TEST WAREHOUSE' } });
    const zone = await prisma.zone.create({ data: { warehouseId: warehouse.id, code: 'TEST-ZONE', name: 'ISOLATED TEST ZONE' } });
    const aisle = await prisma.aisle.create({ data: { zoneId: zone.id, code: 'A1', name: 'Test aisle' } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, code: 'R1', name: 'Test rack' } });
    const level = await prisma.level.create({ data: { rackId: rack.id, code: 'L1', levelNumber: 1 } });
    location = await prisma.location.create({ data: { warehouseId: warehouse.id, zoneId: zone.id, aisleId: aisle.id,
      rackId: rack.id, levelId: level.id, locationCode: `${tag}-LOC`, barcodeValue: `${tag}-LOC`, locationType: 'STORAGE' } });
    category = await prisma.categoryMaster.create({ data: { code: `${tag}-CAT`, name: 'Test category' } });
    await prisma.categoryZoneMapping.create({ data: { categoryId: category.id, zoneId: zone.id } });
    const jobs: Array<[string, any, string[]]> = [
      ['receiver', 'RECEIVING', ['receiving.view', 'receiving.execute']],
      ['other', 'RECEIVING', ['receiving.view', 'receiving.execute']],
      ['supervisor', 'RECEIVING', ['receiving.view', 'receiving.execute', 'receiving.resolve_discrepancy']],
      ['placement', 'SORTING', ['stowing.view', 'stowing.execute']],
      ['sorting', 'SORTING', ['picking.view', 'picking.execute']],
      ['packing', 'PACKING', ['packing.view', 'packing.execute']],
      ['shipping', 'DISPATCH', ['shipping.view', 'shipping.execute']],
    ];
    for (const [name, department, permissions] of jobs) {
      const role = await prisma.role.create({ data: { name: `${tag}-${name}`, applicationClass: 'OPERATIONAL',
        permissions: { create: permissions.map((key) => ({ permission: { connect: { key } } })) } } });
      roleIds.push(role.id);
      const user = await prisma.user.create({ data: { name: `TEST ${name}`, employeeCode: `${tag}-${name}`, passwordHash: await hash(password, 4),
        roles: { create: { roleId: role.id } } } }); people.push(user);
      const device = await prisma.device.create({ data: { code: `${tag}-${name}-DEV`.toUpperCase(), name: `TEST ${name}`, assignedWorkerId: user.id } }); deviceIds.push(device.id);
      const station = await prisma.station.create({ data: { code: `${tag}-${name}-ST`.toUpperCase(), name: `TEST ${name}`, department,
        warehouseId: warehouse.id, assignedWorkerId: user.id, deviceId: device.id } }); stationIds.push(station.id);
      tokens[name] = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ identifier: user.employeeCode, secret: password,
        app: 'WORKER_NATIVE', deviceId: device.code }).expect(201)).body.accessToken;
    }
    arrival = await prisma.expectedArrival.create({ data: { code: `${tag}-ARR`, customerArrivalCardId: `${tag}-CARD`, customerId: `${tag}-SUPPLIER`,
      customerName: 'ISOLATED TEST SUPPLIER', productCount: 3, totalUnits: 90,
      items: { create: [0, 1, 2].map((n) => ({ sku: sku(n), reference: `${tag}-REF-${n}`, productName: `TEST PRODUCT ${n}`, quantity: 30,
        category: category.code, categoryStatus: 'CONFIRMED', storeId: 'MAIN' })) } } });
    const inbound = await prisma.warehouseShipment.create({ data: { code: `${tag}-SHP`, externalShipmentId: `${tag}-EXT`, arrivalId: arrival.id,
      totalCartons: 3, totalProducts: 3, totalUnits: 90 } });
    for (let n = 0; n < 3; n++) {
      const code = `${tag}-CTN-${n}`; cartons.push(code);
      await prisma.warehouseCarton.create({ data: { shipmentId: inbound.id, externalCartonId: code, barcodeValue: code, qrCodeValue: code, cartonNumber: n + 1, totalCartons: 3 } });
    }
    await api('admin', 'post', '/operations/assignments', { workerId: people[0].id, taskKey: 'receiving', relatedType: 'ARRIVAL', relatedCode: arrival.code,
      stationId: stationIds[0] }).expect(201);
  });
  it('shows assigned Receiving and blocks wrong worker or bypass completion', async () => {
    const tasks = (await api('receiver', 'get', '/terminal/assignments').expect(200)).body.open;
    expect(tasks.some((task: any) => task.taskKey === 'receiving' && task.entity.arrival.id === arrival.id)).toBe(true);
    await api('receiver', 'post', `/terminal/assignments/${tasks[0].id}/complete`, {}).expect(403);
    await api('other', 'post', `/receiving/arrivals/${arrival.code}/start`, {}).expect(403);
    sessionId = (await api('receiver', 'post', `/receiving/arrivals/${arrival.code}/start`, {}).expect(201)).body.id;
  });
  it('confirms 3 CARTON CARDS via device-side matching and records duplicate + mismatch outcomes', async () => {
    // Each carton card is confirmed independently (the device matched the
    // identifier locally; the backend re-validates and is the final authority).
    for (const code of cartons) {
      const confirmed = (await api('receiver', 'post', `/receiving/sessions/${sessionId}/confirm-carton`,
        { identifier: code, identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: randomUUID() }).expect(201)).body;
      expect(confirmed.flash.kind).toBe('MATCH');
      expect(confirmed.flash.cardType).toBe('CARTON');
    }
    // Duplicate completion protection: a received carton card is rejected.
    const duplicate = (await api('receiver', 'post', `/receiving/sessions/${sessionId}/confirm-carton`, { identifier: cartons[0] }).expect(201)).body;
    expect(duplicate.flash.kind).toBe('CARD_ALREADY_COMPLETE');
    // Mismatch: nothing is confirmed, the failure is logged (worker activity log).
    const unknown = (await api('receiver', 'post', `/receiving/sessions/${sessionId}/confirm-carton`, { identifier: `${tag}-UNKNOWN` }).expect(201)).body;
    expect(unknown.flash.kind).toBe('MISMATCH');
    // Device-side mismatch report (the worker device found no carton card).
    const rejected = (await api('receiver', 'post', `/receiving/sessions/${sessionId}/mismatch`, { cardType: 'CARTON', identifier: `${tag}-REJECTED`, identifierType: 'QR', source: 'EXTERNAL_SCANNER' }).expect(201)).body;
    expect(rejected.flash.kind).toBe('MISMATCH');
    await api('receiver', 'post', `/receiving/sessions/${sessionId}/complete`, {}).expect(403);
    // The worker activity log recorded every card operation (Admin report source).
    const logs = await prisma.receivingWorkerLog.findMany({ where: { receivingSessionId: sessionId } });
    expect(logs.length).toBeGreaterThanOrEqual(6);
    expect(logs.map((l) => l.result).sort()).toEqual(expect.arrayContaining(['MATCH', 'MATCH', 'MATCH', 'DUPLICATE', 'MISMATCH', 'MISMATCH']));
    // Supervisor discrepancy flow (explicit flag) still works on the session.
    const flagged = (await api('receiver', 'post', `/receiving/sessions/${sessionId}/flag`, { code: `${tag}-UNKNOWN`, reason: 'ISOLATED TEST: unknown label scanned' }).expect(201)).body;
    const open = flagged.discrepancies.find((item: any) => item.status === 'OPEN');
    expect(open).toBeDefined();
    await api('supervisor', 'post', `/receiving/discrepancies/${open.id}/resolve`, { resolution: 'ISOLATED TEST: wrong label removed; expected cartons verified' }).expect(201);
  });
  it('records 90 units through HTTP, closes at 50 and supports early close at 37', async () => {
    let tote = (await api('receiver', 'post', '/fulfillment/containers', { type: 'RECEIVING', capacity: 50, label: tag }).expect(201)).body; totes.push(tote.code);
    for (let n = 0; n < 90; n++) {
      const operationId = `${tag}-UNIT-${n}`;
      const payload = { sku: sku(Math.floor(n / 30)), containerCode: tote.code, cartonCode: cartons[Math.floor(n / 30)], operationId };
      const result = (await api('receiver', 'post', `/fulfillment/receiving/sessions/${sessionId}/scan-article`, payload).expect(201)).body;
      articles.push({ code: result.flash.article.code, sku: payload.sku });
      if (n === 0) {
        const replay = (await api('receiver', 'post', `/fulfillment/receiving/sessions/${sessionId}/scan-article`, payload).expect(201)).body;
        expect(replay.replay).toBe(true);
      }
      if (n === 49) { expect(result.flash.containerFull).toBe(true); expect(result.flash.containerCount).toBe(50); }
      if (n === 86) await api('receiver', 'post', `/fulfillment/containers/${tote.code}/close`, {}).expect(201);
      if (n === 49 || n === 86) {
        // Existing system requires this explicit worker API call. Automatic successor creation is NOT claimed.
        tote = (await api('receiver', 'post', '/fulfillment/containers', { type: 'RECEIVING', capacity: 50, label: tag }).expect(201)).body; totes.push(tote.code);
      }
    }
    await api('receiver', 'post', `/fulfillment/containers/${tote.code}/close`, {}).expect(201);
    const result = (await api('receiver', 'post', `/receiving/sessions/${sessionId}/complete`, {}).expect(201)).body;
    expect(result.tally.receivedUnits).toBe(90); expect(result.status).toBe('COMPLETED');
    expect(await prisma.articleUnit.count({ where: { receivingSessionId: sessionId } })).toBe(90);
    const assignments = (await api('placement', 'get', '/terminal/assignments').expect(200)).body.open;
    observations.automaticPlacementHandoff = assignments.some((task: any) => task.taskKey === 'placement') ? 'PASS' : 'BLOCKED: automatic product-placement task not implemented';
    observations.automaticContainerRollover = 'BLOCKED: next tote still requires explicit creation API';
  });
  it('exercises existing storage customer matching packing shipping and Admin trace without DB state edits', async () => {
    for (let n = 0; n < 3; n++) {
      const order = `${tag}-ORDER-${n}`; orders.push(order);
      await request(app.getHttpServer()).post('/api/v1/integrations/orders').set('x-api-key', integrationKey).send({ externalOrderReference: order, externalCustomerReference: `${tag}-CUSTOMER-${n}`,
        items: [{ store: 'MAIN', externalProductCode: sku(n), productName: `TEST PRODUCT ${n}`, requestedQuantity: 30 }] }).expect(201);
      const bin = (await api('receiver', 'post', '/fulfillment/containers', { type: 'CUSTOMER', orderReference: order, capacity: 50 }).expect(201)).body; bins.push(bin.code);
    }
    await api('receiver', 'post', '/fulfillment/sorting/store', { articleCode: articles[0].code, locationCode: location.locationCode }).expect(403);
    for (const article of articles) {
      await api('placement', 'post', '/fulfillment/sorting/store', { articleCode: article.code, locationCode: location.locationCode }).expect(201);
      const customerIndex = Number(article.sku.slice(-1));
      if (article === articles[0]) await api('sorting', 'post', '/fulfillment/order-sorting/assign', { articleCode: article.code, containerCode: bins[1] }).expect(409);
      await api('sorting', 'post', '/fulfillment/order-sorting/assign', { articleCode: article.code, containerCode: bins[customerIndex] }).expect(201);
    }
    await api('sorting', 'post', '/fulfillment/order-sorting/assign', { articleCode: articles[0].code, containerCode: bins[0] }).expect(409);
    for (const bin of bins) {
      const packed = (await api('packing', 'post', `/fulfillment/packing/containers/${bin}/pack`, {}).expect(201)).body;
      const code = packed.shipment.code;
      await api('shipping', 'get', `/fulfillment/shipping/shipments/${code}`).expect(200);
      await api('shipping', 'post', `/fulfillment/shipping/shipments/${code}/ship`, {}).expect(201);
      await api('shipping', 'post', `/fulfillment/shipping/shipments/${code}/ship`, {}).expect(409);
      const admin = (await api('admin', 'get', `/fulfillment/outbound-shipments?q=${code}`).expect(200)).body;
      expect(admin[0].status).toBe('SHIPPED'); expect(admin[0]._count.articles).toBe(30);
    }
    expect(await prisma.articleUnit.count({ where: { receivingSessionId: sessionId, status: 'SHIPPED' } })).toBe(90);
    expect(await prisma.articleUnit.count({ where: { receivingSessionId: sessionId, orderId: null } })).toBe(0);
    const trace = (await api('admin', 'get', `/fulfillment/articles/${articles[0].code}/trace`).expect(200)).body;
    expect(trace.trace.expectedArrival).toBe(arrival.code);
    observations.stockPath = 'PASS: existing HTTP stock operations, 90 units, 3 customer orders';
    observations.fullRequestedAssignedChain = 'BLOCKED: Placement/task auto handoff, shipping verification binding, live devices and rollout remain separate gaps';
  });
  afterAll(async () => {
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/warehouse-volume-observations.json', JSON.stringify({ fixture: tag, observations, productionData: false }, null, 2));
    // CI database is disposable. Only fixture setup preceded HTTP operations; no state edits were used to move stock.
    await app?.close(); await prisma.$disconnect();
    if (previousIntegrationKey === undefined) delete process.env.WAREHOUSE_INTEGRATION_API_KEY; else process.env.WAREHOUSE_INTEGRATION_API_KEY = previousIntegrationKey;
  });
});
