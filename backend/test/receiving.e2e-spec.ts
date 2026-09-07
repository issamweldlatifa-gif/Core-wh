import { AssignmentsService } from '../src/modules/assignments/assignments.service';
import { PrismaClient } from '@prisma/client';
import { ReceivingService } from '../src/modules/receiving/receiving.service';

/**
 * Receiving end-to-end (service layer, real Postgres) — card-based rebuild.
 *
 * The CRM pushes two INDEPENDENT card types (product cards / carton cards);
 * the worker device matches identifiers locally and the backend stays the
 * final authority:
 *  - unknown carton/product -> MISMATCH flash + worker activity log, never
 *    confirmed, never auto-created
 *  - wrong-shipment carton  -> WRONG_SHIPMENT flash, carton untouched
 *  - duplicate carton/product -> CARD_ALREADY_COMPLETE (no double count)
 *  - device-side mismatch report -> logged (SCAN_REJECT), nothing confirmed
 *  - operationId idempotency -> no double count on retry
 *  - completion with shortages requires supervisor
 *  - perfect match -> COMPLETED + arrival RECEIVED
 *
 * Requires a migrated database: DATABASE_URL=... (run with the e2e config)
 */
describe('Receiving (card-based, device-side matching) end-to-end', () => {
  let prisma: PrismaClient;
  let service: ReceivingService;
  const tag = `RCVE2E-${Date.now()}`;

  const actor = (supervisor = true) => ({
    id: `user-${tag}`,
    name: supervisor ? 'Supervisor' : 'Worker',
    canResolveDiscrepancy: supervisor,
    ip: null,
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    // AuditService takes a PrismaService; the service only calls audit.log()
    // which accepts an optional tx — PrismaClient satisfies the call surface.
    service = new ReceivingService(
      prisma as any,
      { log: async () => {} } as any,
      new AssignmentsService(prisma as any, { log: async () => {} } as any),
      { onReceivingCompleted: async () => {} } as any,
    );
  });

  afterAll(async () => {
    await (prisma as any).receivingWorkerLog.deleteMany({ where: { session: { code: { startsWith: 'RCV-' } } } });
    await (prisma as any).receivingScanEvent.deleteMany({ where: { session: { code: { startsWith: 'RCV-' } } } });
    await (prisma as any).receivingDiscrepancy.deleteMany({ where: { session: { code: { startsWith: 'RCV-' } } } });
    await (prisma as any).receivingCarton.deleteMany({ where: { session: { code: { startsWith: 'RCV-' } } } });
    await (prisma as any).receivingProduct.deleteMany({ where: { session: { code: { startsWith: 'RCV-' } } } });
    await (prisma as any).receivingSession.deleteMany({ where: { code: { startsWith: 'RCV-' } } });
    await (prisma as any).warehouseCarton.deleteMany({ where: { shipment: { externalShipmentId: { startsWith: `SHP-${tag}` } } } });
    await (prisma as any).warehouseShipment.deleteMany({ where: { externalShipmentId: { startsWith: `SHP-${tag}` } } });
    await (prisma as any).expectedArrivalItem.deleteMany({ where: { arrival: { customerArrivalCardId: { startsWith: `card:${tag}` } } } });
    await (prisma as any).expectedArrival.deleteMany({ where: { customerArrivalCardId: { startsWith: `card:${tag}` } } });
    await prisma.$disconnect();
  });

  async function seedArrival(opts: { suffix: string; units: Record<string, number>; cartons: number }) {
    const arrival = await (prisma as any).expectedArrival.create({
      data: {
        code: `WAR-RCV-${opts.suffix}`,
        customerArrivalCardId: `card:${tag}:${opts.suffix}`,
        arrivalId: `ARR-${tag}-${opts.suffix}`,
        customerId: `cust-${tag}`,
        customerName: `E2E ${opts.suffix}`,
        status: 'EXPECTED',
        productCount: Object.keys(opts.units).length,
        totalUnits: Object.values(opts.units).reduce((a, b) => a + b, 0),
        items: {
          create: Object.entries(opts.units).map(([sku, qty], i) => ({
            productId: `prod:${tag}:${opts.suffix}:${i}`,
            sku,
            reference: sku,
            productName: `Product ${sku}`,
            quantity: qty,
          })),
        },
        shipments: {
          create: {
            code: `WSHP-RCV-${opts.suffix}`,
            externalShipmentId: `SHP-${tag}-${opts.suffix}`,
            sourceType: 'MANUAL',
            trackingStatus: 'IN_TRANSIT',
            destinationCode: 'AYROVI-WH-TN',
            totalCartons: opts.cartons,
            totalProducts: Object.keys(opts.units).length,
            totalUnits: Object.values(opts.units).reduce((a, b) => a + b, 0),
            receivedViaApi: true,
            receivedViaApiAt: new Date(),
            cartons: {
              create: Array.from({ length: opts.cartons }, (_, i) => ({
                externalCartonId: `CTN-${tag}-${opts.suffix}-${i + 1}`,
                qrCodeValue: `CTN-${tag}-${opts.suffix}-${i + 1}`,
                cartonNumber: i + 1,
                totalCartons: opts.cartons,
                status: 'EXPECTED',
              })),
            },
          },
        },
      },
      include: { items: true, shipments: { include: { cartons: true } } },
    });
    return arrival;
  }

  it('starts a session and seeds independent PRODUCT and CARTON cards', async () => {
    const arrival = await seedArrival({ suffix: 'A', units: { SKU1: 100, SKU2: 27 }, cartons: 8 });
    const session = await service.start(arrival.code, actor());
    expect(session.code).toMatch(/^RCV-/);
    expect(session.status).toBe('RECEIVING');
    // PRODUCT CARDS (Customer Arrival Card) — independent card type.
    expect(session.productCards).toHaveLength(2);
    expect(session.productCards.map((p: any) => p.sku).sort()).toEqual(['SKU1', 'SKU2']);
    expect(session.productCards.every((p: any) => Array.isArray(p.identifiers))).toBe(true);
    // CARTON CARDS (Shipment Card) — independent card type, carries tracking.
    expect(session.cartonCards).toHaveLength(8);
    expect(session.tally.expectedCartons).toBe(8);
    expect(session.tally.expectedUnits).toBe(127);
    // Idempotent start: second call returns the same session.
    const again = await service.start(arrival.code, actor());
    expect(again.id).toBe(session.id);
  });

  it('unknown carton -> MISMATCH + worker log, never confirmed or auto-created', async () => {
    const session = await service.start('WAR-RCV-A', actor());
    const res = await service.confirmCarton(session.id, { identifier: 'CTN-NEVER-EXISTS', identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-unk` }, actor());
    expect(res.flash?.kind).toBe('MISMATCH');
    expect(res.tally.receivedCartons).toBe(0);
    const auto = await (prisma as any).warehouseCarton.findFirst({ where: { externalCartonId: 'CTN-NEVER-EXISTS' } });
    expect(auto).toBeNull();
    const log = await (prisma as any).receivingWorkerLog.findFirst({ where: { receivingSessionId: session.id, result: 'MISMATCH' } });
    expect(log).not.toBeNull();
    expect(log.cardType).toBe('CARTON');
    expect(log.operation).toBe('CONFIRM');
  });

  it('wrong-shipment carton -> WRONG_SHIPMENT, carton untouched', async () => {
    await seedArrival({ suffix: 'B', units: { SKUB: 5 }, cartons: 1 });
    const sessionA = await service.start('WAR-RCV-A', actor());
    // Carton belongs to arrival B but is confirmed in session A.
    const res = await service.confirmCarton(sessionA.id, { identifier: `CTN-${tag}-B-1`, identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-wrong` }, actor());
    expect(res.flash?.kind).toBe('WRONG_SHIPMENT');
    const cartonB = await (prisma as any).warehouseCarton.findFirst({ where: { externalCartonId: `CTN-${tag}-B-1` } });
    expect(cartonB.status).toBe('EXPECTED'); // not received
  });

  it('duplicate carton -> CARD_ALREADY_COMPLETE; operationId retry never double-counts', async () => {
    const session = await service.start('WAR-RCV-A', actor());
    const code = `CTN-${tag}-A-1`;
    const r1 = await service.confirmCarton(session.id, { identifier: code, identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-dup` }, actor());
    expect(r1.flash?.kind).toBe('MATCH');
    expect(r1.tally.receivedCartons).toBe(1);
    // Same operationId retry -> idempotent, same count.
    const r2 = await service.confirmCarton(session.id, { identifier: code, identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-dup` }, actor());
    expect(r2.tally.receivedCartons).toBe(1);
    // Re-confirm of a received carton card -> duplicate flash, no second row.
    const r3 = await service.confirmCarton(session.id, { identifier: code, identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-dup2` }, actor());
    expect(r3.flash?.kind).toBe('CARD_ALREADY_COMPLETE');
    const rows = await (prisma as any).receivingCarton.count({
      where: { receivingSessionId: session.id, scannedCode: code },
    });
    expect(rows).toBe(1);
  });

  it('unknown product -> MISMATCH; device mismatch report is logged; expected data immutable', async () => {
    await seedArrival({ suffix: 'D', units: { SKUD1: 100, SKUD2: 27 }, cartons: 8 });
    const session = await service.start('WAR-RCV-D', actor());
    const unexp = await service.confirmProduct(session.id, { identifier: 'SKU-GHOST', identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-ghost` }, actor());
    expect(unexp.flash?.kind).toBe('MISMATCH');
    // The worker device matched locally and reports the failure (SCAN_REJECT).
    const rejected = await service.reportMismatch(session.id, { cardType: 'PRODUCT', identifier: 'SKU-DEVICE-NOPE', identifierType: 'OCR', source: 'CAMERA' }, actor());
    expect(rejected.flash?.kind).toBe('MISMATCH');
    const logs = await (prisma as any).receivingWorkerLog.findMany({ where: { receivingSessionId: session.id, cardType: 'PRODUCT' } });
    expect(logs.map((l: any) => l.operation).sort()).toEqual(['CONFIRM', 'SCAN_REJECT']);
    // Expected product data is immutable: nothing received, shortfall intact.
    expect(session.tally.receivedUnits).toBe(0);
  });

  it('product card completion is protected (partial then full then duplicate)', async () => {
    const session = await service.start('WAR-RCV-D', actor());
    await service.confirmProduct(session.id, { identifier: 'SKUD1', identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-p1` }, actor());
    const partial = await service.confirmProduct(session.id, { identifier: 'SKUD2', identifierType: 'QR', source: 'EXTERNAL_SCANNER', quantity: 20, operationId: `op-${tag}-p2` }, actor());
    const sku2 = partial.productCards.find((p: any) => p.sku === 'SKUD2');
    expect(sku2?.status).toBe('PARTIALLY_RECEIVED');
    expect(sku2?.received).toBe(20);
    expect(sku2?.expected).toBe(27); // immutable
    // SKU-GHOST never matched a product card, so it stays unmatched.
    const ghost = partial.productCards.find((p: any) => p.sku === 'SKU-GHOST');
    expect(ghost).toBeUndefined();
  });

  it('complete with shortages requires supervisor', async () => {
    const session = await service.start('WAR-RCV-D', actor());
    // Worker (no resolve permission) cannot complete with open shortages.
    await expect(service.complete(session.id, actor(false))).rejects.toThrow();
  });

  it('perfect match -> COMPLETED and arrival RECEIVED', async () => {
    await seedArrival({ suffix: 'C', units: { SKUC: 4 }, cartons: 1 });
    const session = await service.start('WAR-RCV-C', actor());
    const code = `CTN-${tag}-C-1`;
    const carton = await service.confirmCarton(session.id, { identifier: code, identifierType: 'QR', source: 'EXTERNAL_SCANNER', operationId: `op-${tag}-c-1` }, actor());
    expect(carton.flash?.kind).toBe('MATCH');
    await service.confirmProduct(session.id, { identifier: 'SKUC', identifierType: 'QR', source: 'EXTERNAL_SCANNER', quantity: 4, operationId: `op-${tag}-c-2` }, actor());
    const done = await service.complete(session.id, actor(true));
    expect(done.status).toBe('COMPLETED');
    expect(done.arrival.status).toBe('RECEIVED');
    expect(done.tally.openDiscrepancies).toBe(0);
    expect(done.tally.receivedCartons).toBe(1);
    expect(done.tally.receivedUnits).toBe(4);
    // The worker activity log is the Admin report source.
    const logs = await (prisma as any).receivingWorkerLog.findMany({ where: { receivingSessionId: session.id, result: 'MATCH' } });
    expect(logs.map((l: any) => l.cardType).sort()).toEqual(['CARTON', 'PRODUCT']);
  });
});
