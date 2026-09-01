import { PrismaClient } from '@prisma/client';
import { ReceivingService } from '../src/modules/receiving/receiving.service';

/**
 * Phase 2 — Receiving end-to-end (service layer, real Postgres).
 *
 * Exercises a transmitted shipment (8 cartons / 100 products across lines /
 * 127 units) and the failure/edge rules:
 *  - unknown carton -> UNKNOWN_CARTON discrepancy, never auto-created
 *  - wrong-shipment carton -> WRONG_SHIPMENT discrepancy, not received
 *  - duplicate scan / operationId retry -> no double count
 *  - unexpected product -> UNEXPECTED_PRODUCT discrepancy
 *  - expected data immutable; shortage -> SHORT
 *  - completion with open discrepancies requires supervisor
 *  - perfect match -> COMPLETED + arrival RECEIVED
 *
 * Requires a migrated database: DATABASE_URL=... npm run test:e2e
 */
describe('Phase 2 — Receiving', () => {
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
    service = new ReceivingService(prisma as any, { log: async () => {} } as any);
  });

  afterAll(async () => {
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

  it('starts a session and seeds expected products', async () => {
    const arrival = await seedArrival({ suffix: 'A', units: { SKU1: 100, SKU2: 27 }, cartons: 8 });
    const session = await service.start(arrival.code, actor());
    expect(session.code).toMatch(/^RCV-/);
    expect(session.status).toBe('RECEIVING');
    expect(session.products).toHaveLength(2);
    expect(session.tally.expectedCartons).toBe(8);
    expect(session.tally.expectedUnits).toBe(127);
    // Idempotent start: second call returns the same session.
    const again = await service.start(arrival.code, actor());
    expect(again.id).toBe(session.id);
  });

  it('unknown carton -> discrepancy, never auto-created', async () => {
    const session = await service.start('WAR-RCV-A', actor());
    const res = await service.scanCarton(session.id, 'CTN-NEVER-EXISTS', 'QR', actor(), 'op-unk-1');
    expect(res.flash?.kind).toBe('UNKNOWN_CARTON');
    const auto = await (prisma as any).warehouseCarton.findFirst({ where: { externalCartonId: 'CTN-NEVER-EXISTS' } });
    expect(auto).toBeNull();
  });

  it('wrong-shipment carton -> discrepancy and not received', async () => {
    const b = await seedArrival({ suffix: 'B', units: { SKUB: 5 }, cartons: 1 });
    const sessionA = await service.start('WAR-RCV-A', actor());
    // Carton belongs to arrival B but scanned in session A.
    const res = await service.scanCarton(sessionA.id, `CTN-${tag}-B-1`, 'QR', actor(), 'op-wrong-1');
    expect(res.flash?.kind).toBe('WRONG_SHIPMENT');
    const cartonB = await (prisma as any).warehouseCarton.findFirst({ where: { externalCartonId: `CTN-${tag}-B-1` } });
    expect(cartonB.status).toBe('EXPECTED'); // not received
  });

  it('duplicate scan / same operationId does not double-count', async () => {
    const session = await service.start('WAR-RCV-A', actor());
    const code = `CTN-${tag}-A-1`;
    await service.scanCarton(session.id, code, 'QR', actor(), 'op-dup-1');
    const r1 = await service.receiveCarton(session.id, code, actor(), 'op-dup-2');
    expect(r1.tally.receivedCartons).toBe(1);
    // Same operationId retry -> idempotent, same count.
    const r2 = await service.receiveCarton(session.id, code, actor(), 'op-dup-2');
    expect(r2.tally.receivedCartons).toBe(1);
    // Plain rescan of received carton -> duplicate flash, no row.
    const r3 = await service.scanCarton(session.id, code, 'QR', actor(), 'op-dup-3');
    expect(r3.flash?.kind).toBe('DUPLICATE_CARTON');
    const rows = await (prisma as any).receivingCarton.count({
      where: { receivingSessionId: session.id, scannedCode: code },
    });
    expect(rows).toBe(1);
  });

  it('unexpected product -> discrepancy; expected immutable; shortage tracked', async () => {
    await seedArrival({ suffix: 'D', units: { SKUD1: 100, SKUD2: 27 }, cartons: 8 });
    const session = await service.start('WAR-RCV-D', actor());
    // Receive full SKUD1, partial SKUD2 (27 expected, 20 received -> short 7).
    await service.receiveProduct(session.id, 'SKUD1', 100, actor());
    const partial = await service.receiveProduct(session.id, 'SKUD2', 20, actor());
    const sku2 = partial.products.find((p: any) => p.sku === 'SKUD2');
    expect(sku2?.status).toBe('PARTIALLY_RECEIVED');
    expect(sku2?.received).toBe(20);
    expect(sku2?.expected).toBe(27); // immutable
    const unexp = await service.receiveProduct(session.id, 'SKU-GHOST', 3, actor());
    expect(unexp.flash?.kind).toBe('UNEXPECTED_PRODUCT');
  });

  it('complete with discrepancies requires supervisor', async () => {
    const session = await service.start('WAR-RCV-D', actor());
    // Worker (no resolve perm) cannot complete with open discrepancies.
    await expect(service.complete(session.id, actor(false))).rejects.toThrow();
  });

  it('perfect match -> COMPLETED and arrival RECEIVED', async () => {
    const c = await seedArrival({ suffix: 'C', units: { SKUC: 4 }, cartons: 1 });
    const session = await service.start('WAR-RCV-C', actor());
    const code = `CTN-${tag}-C-1`;
    await service.scanCarton(session.id, code, 'QR', actor(), 'op-c-1');
    await service.receiveCarton(session.id, code, actor(), 'op-c-2');
    await service.receiveProduct(session.id, 'SKUC', 4, actor());
    const done = await service.complete(session.id, actor(true));
    expect(done.status).toBe('COMPLETED');
    expect(done.arrival.status).toBe('RECEIVED');
    expect(done.tally.openDiscrepancies).toBe(0);
    expect(done.tally.receivedCartons).toBe(1);
    expect(done.tally.receivedUnits).toBe(4);
  });
});
