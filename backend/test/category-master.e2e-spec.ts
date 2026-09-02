import { PrismaClient } from '@prisma/client';
import { ExpectedArrivalsService } from '../src/modules/expected-arrivals/expected-arrivals.service';
import { ReceivingService } from '../src/modules/receiving/receiving.service';
import { PutawayService } from '../src/modules/putaway/putaway.service';
import { CategoriesService } from '../src/modules/categories/categories.service';

/**
 * FINAL PHASE — Category Master + validation + configurable sorting mapping.
 *
 * Proves, end to end on a real Postgres, the full path:
 *   CRM Card -> API -> validation vs Category Master -> Expected Arrival ->
 *   Shipment -> Carton -> Receiving -> Category -> Sorting destination ->
 *   Putaway -> Location.
 *
 * Matrix covered:
 *   1.  valid ACTIVE category (+ valid subcategory)   -> CONFIRMED
 *   2.  nonexistent category                          -> NEEDS_REVIEW (kept as text, never coerced)
 *   3.  inactive category                             -> NEEDS_REVIEW
 *   4.  card without category / UNCLASSIFIED          -> NEEDS_REVIEW
 *   5.  unknown subcategory under a valid category    -> NEEDS_REVIEW
 *   6.  duplicate card replay                         -> idempotent, no duplicates
 *   7.  category + status survive into Receiving
 *   8.  sorting queue: CONFIRMED + mapped             -> DESTINATION (from config)
 *   9.  sorting queue: NEEDS_REVIEW present           -> MANUAL REVIEW (never a wrong destination)
 *   10. sorting queue: CONFIRMED but unmapped         -> UNMAPPED (no guessing)
 *   11. category survives Putaway placement (carton stored; audit carries the decision)
 *
 * Requires a migrated database: DATABASE_URL=... npm run test:e2e
 */
describe('FINAL PHASE — Category Master + sorting mapping', () => {
  let prisma: PrismaClient;
  let arrivals: ExpectedArrivalsService;
  let receiving: ReceivingService;
  let putaway: PutawayService;
  let categories: CategoriesService;
  const tag = `CATM-${Date.now()}`;

  const principal = { kind: 'static' as const, id: null, name: 'e2e-crm', idempotencyKey: null };
  // PutawaySession.workerId is a real FK -> a real user row is created in
  // beforeAll and its id patched in here.
  const actor = { id: '', name: 'Supervisor', canResolveDiscrepancy: true, ip: null };
  const auditRows: any[] = [];
  const captureAudit = { log: async (entry: any) => { auditRows.push(entry); } } as any;

  let activeCatId = '';
  let inactiveCatId = '';
  let zoneId = '';
  let warehouseId = '';
  let locationCode = '';

  const cardEvent = (suffix: string, products: any[]) => ({
    event: 'customer_arrival_card.created' as const,
    arrival: { id: `ARR-${tag}-${suffix}`, reference: null },
    customer_arrival_card: {
      id: `card:${tag}:${suffix}`,
      customer: { id: `cust-${tag}`, name: `CatMaster E2E ${suffix}` },
      store: { id: 'STORE-E2E', name: 'E2E STORE' },
      products,
    },
  });

  async function attachShipment(cardId: string, suffix: string, cartons: number) {
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: cardId } });
    return (prisma as any).warehouseShipment.create({
      data: {
        code: `WSHP-${tag}-${suffix}`,
        externalShipmentId: `SHP-${tag}-${suffix}`,
        arrivalId: arrival.id,
        sourceType: 'MANUAL',
        trackingStatus: 'IN_TRANSIT',
        totalCartons: cartons,
        cartons: {
          create: Array.from({ length: cartons }, (_, i) => ({
            externalCartonId: `CTN-${tag}-${suffix}-${i + 1}`,
            qrCodeValue: `CTN-${tag}-${suffix}-${i + 1}`,
            cartonNumber: i + 1,
            totalCartons: cartons,
            status: 'EXPECTED',
          })),
        },
      },
      include: { cartons: true },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    arrivals = new ExpectedArrivalsService(prisma as any, captureAudit);
    receiving = new ReceivingService(prisma as any, captureAudit);
    categories = new CategoriesService(prisma as any, captureAudit);
    putaway = new PutawayService(prisma as any, captureAudit, categories);

    // --- Real worker (FK target for the putaway session) ---
    const worker = await (prisma as any).user.create({
      data: { name: 'E2E Worker', employeeCode: `E2E-${tag}` },
    });
    actor.id = worker.id;

    // --- Category Master fixtures ---
    const shoes = await (prisma as any).categoryMaster.create({
      data: { code: `SHOES-${tag}`, name: 'Shoes', subcategories: ['SPORTS', 'CASUAL'] },
    });
    activeCatId = shoes.id;
    const legacy = await (prisma as any).categoryMaster.create({
      data: { code: `LEGACY-${tag}`, name: 'Legacy', status: 'INACTIVE' },
    });
    inactiveCatId = legacy.id;

    // --- Minimal physical tree for placement + mapping ---
    const wh = await (prisma as any).warehouse.create({ data: { code: `WH-${tag}`, name: 'E2E WH' } });
    warehouseId = wh.id;
    const zone = await (prisma as any).zone.create({ data: { warehouseId, code: `Z-${tag}`, name: 'Sorting zone' } });
    zoneId = zone.id;
    const aisle = await (prisma as any).aisle.create({ data: { zoneId, code: 'A01', name: 'A01' } });
    const rack = await (prisma as any).rack.create({ data: { aisleId: aisle.id, code: 'R01', name: 'R01' } });
    const level = await (prisma as any).level.create({ data: { rackId: rack.id, code: 'L01', levelNumber: 1 } });
    locationCode = `LOC-${tag}-01`;
    await (prisma as any).location.create({
      data: {
        warehouseId, zoneId, aisleId: aisle.id, rackId: rack.id, levelId: level.id,
        locationCode, barcodeValue: locationCode, locationType: 'STORAGE', status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    const cardPrefix = `card:${tag}`;
    await (prisma as any).receivingDiscrepancy.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: { startsWith: cardPrefix } } } } });
    await (prisma as any).receivingCarton.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: { startsWith: cardPrefix } } } } });
    await (prisma as any).receivingProduct.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: { startsWith: cardPrefix } } } } });
    await (prisma as any).receivingSession.deleteMany({ where: { expectedArrival: { customerArrivalCardId: { startsWith: cardPrefix } } } });
    await (prisma as any).cartonPlacement.deleteMany({ where: { carton: { externalCartonId: { startsWith: `CTN-${tag}` } } } });
    await (prisma as any).warehouseCarton.deleteMany({ where: { externalCartonId: { startsWith: `CTN-${tag}` } } });
    await (prisma as any).warehouseShipment.deleteMany({ where: { externalShipmentId: { startsWith: `SHP-${tag}` } } });
    await (prisma as any).expectedArrivalItem.deleteMany({ where: { arrival: { customerArrivalCardId: { startsWith: cardPrefix } } } });
    await (prisma as any).expectedArrival.deleteMany({ where: { customerArrivalCardId: { startsWith: cardPrefix } } });
    await (prisma as any).categoryZoneMapping.deleteMany({ where: { category: { code: { endsWith: tag } } } });
    await (prisma as any).location.deleteMany({ where: { warehouseId } });
    await (prisma as any).level.deleteMany({ where: { rack: { aisle: { zone: { warehouseId } } } } });
    await (prisma as any).rack.deleteMany({ where: { aisle: { zone: { warehouseId } } } });
    await (prisma as any).aisle.deleteMany({ where: { zone: { warehouseId } } });
    await (prisma as any).zone.deleteMany({ where: { warehouseId } });
    await (prisma as any).warehouse.deleteMany({ where: { id: warehouseId } });
    await (prisma as any).categoryMaster.deleteMany({ where: { code: { endsWith: tag } } });
    await (prisma as any).putawaySession.deleteMany({ where: { worker: { employeeCode: `E2E-${tag}` } } });
    await (prisma as any).user.deleteMany({ where: { employeeCode: `E2E-${tag}` } });
    await prisma.$disconnect();
  });

  // 1 -----------------------------------------------------------------
  it('valid ACTIVE category + valid subcategory -> CONFIRMED', async () => {
    const res = await arrivals.receiveCard(
      cardEvent('ok', [
        { sku: `SKU-${tag}-OK`, product_name: 'Basket', quantity: 2, category: `shoes-${tag}`, subcategory: 'sports', classification_source: 'AI' },
      ]) as any,
      principal,
    );
    expect(res.created).toBe(true);
    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:ok` } },
    });
    expect(item.category).toBe(`SHOES-${tag}`);
    expect(item.subcategory).toBe('SPORTS');
    expect(item.classificationSource).toBe('AI');
    expect(item.categoryStatus).toBe('CONFIRMED');
  });

  // 2 -----------------------------------------------------------------
  it('nonexistent category -> NEEDS_REVIEW, text kept but never confirmed', async () => {
    await arrivals.receiveCard(
      cardEvent('unknown', [
        { sku: `SKU-${tag}-U`, product_name: 'Mystery', quantity: 1, category: `NO-SUCH-${tag}`, classification_source: 'AI' },
      ]) as any,
      principal,
    );
    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:unknown` } },
    });
    expect(item.categoryStatus).toBe('NEEDS_REVIEW');
    // The raw text is preserved for the reviewer but is NOT a category.
    expect(item.category).toBe(`NO-SUCH-${tag}`);
  });

  // 3 -----------------------------------------------------------------
  it('inactive category -> NEEDS_REVIEW', async () => {
    await arrivals.receiveCard(
      cardEvent('inactive', [
        { sku: `SKU-${tag}-I`, product_name: 'Old line', quantity: 1, category: `LEGACY-${tag}`, classification_source: 'MANUAL' },
      ]) as any,
      principal,
    );
    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:inactive` } },
    });
    expect(item.categoryStatus).toBe('NEEDS_REVIEW');
  });

  // 4 -----------------------------------------------------------------
  it('missing category and UNCLASSIFIED -> NEEDS_REVIEW, never counted as classified', async () => {
    await arrivals.receiveCard(
      cardEvent('missing', [
        { sku: `SKU-${tag}-M1`, product_name: 'No cat', quantity: 1 },
        { sku: `SKU-${tag}-M2`, product_name: 'Unclassified', quantity: 1, category: 'UNCLASSIFIED' },
      ]) as any,
      principal,
    );
    const items = await (prisma as any).expectedArrivalItem.findMany({
      where: { arrival: { customerArrivalCardId: `card:${tag}:missing` } },
    });
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.categoryStatus).toBe('NEEDS_REVIEW');
      expect(it.category).toBeNull(); // UNCLASSIFIED is not a category either
    }
    // Audit stream carries the explicit NEEDS_REVIEW event.
    const nr = auditRows.filter((r) => r.action === 'CATEGORY_NEEDS_REVIEW');
    expect(nr.length).toBeGreaterThan(0);
  });

  // 5 -----------------------------------------------------------------
  it('unknown subcategory under a valid category -> NEEDS_REVIEW', async () => {
    await arrivals.receiveCard(
      cardEvent('badsub', [
        { sku: `SKU-${tag}-BS`, product_name: 'Weird sub', quantity: 1, category: `SHOES-${tag}`, subcategory: 'DIVING', classification_source: 'AI' },
      ]) as any,
      principal,
    );
    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:badsub` } },
    });
    expect(item.categoryStatus).toBe('NEEDS_REVIEW');
  });

  // 6 -----------------------------------------------------------------
  it('duplicate card replay stays idempotent (no duplicate items, verdicts unchanged)', async () => {
    const again = await arrivals.receiveCard(
      cardEvent('ok', [
        { sku: `SKU-${tag}-OK`, product_name: 'Basket', quantity: 2, category: `shoes-${tag}`, subcategory: 'sports', classification_source: 'AI' },
      ]) as any,
      principal,
    );
    expect(again.created).toBe(false);
    const count = await (prisma as any).expectedArrivalItem.count({
      where: { arrival: { customerArrivalCardId: `card:${tag}:ok` } },
    });
    expect(count).toBe(1);
  });

  // 7 -----------------------------------------------------------------
  it('category, subcategory and verdict survive into the Receiving session', async () => {
    await attachShipment(`card:${tag}:ok`, 'ok', 1);
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:ok` } });
    const session = await receiving.start(arrival.id, actor as any);
    const p: any = session.products.find((x: any) => x.sku === `SKU-${tag}-OK`);
    expect(p).toBeDefined();
    expect(p.category).toBe(`SHOES-${tag}`);
    expect(p.subcategory).toBe('SPORTS');
    expect(p.categoryStatus).toBe('CONFIRMED');
  });

  // 8 -----------------------------------------------------------------
  it('CONFIRMED + configured mapping -> sorting DESTINATION from configuration', async () => {
    // Configure the mapping (this is data, not code).
    await categories.setZoneMapping(activeCatId, zoneId, { id: actor.id });

    // Receive the carton so it enters the sorting/putaway queue.
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:ok` } });
    const session = await (prisma as any).receivingSession.findFirst({ where: { arrivalId: arrival.id, status: 'RECEIVING' } });
    await receiving.receiveCarton(session.id, `CTN-${tag}-ok-1`, actor as any, `op-${tag}-1`);

    const queue = await putaway.queue(200);
    const mine: any = queue.find((c: any) => c.externalCartonId === `CTN-${tag}-ok-1`);
    expect(mine).toBeDefined();
    expect(mine.classification).toEqual([
      { category: `SHOES-${tag}`, subcategory: 'SPORTS', status: 'CONFIRMED' },
    ]);
    expect(mine.sorting.kind).toBe('DESTINATION');
    expect(mine.sorting.zone.code).toBe(`Z-${tag}`);
  });

  // 9 -----------------------------------------------------------------
  it('NEEDS_REVIEW carton -> MANUAL REVIEW, never a destination', async () => {
    await attachShipment(`card:${tag}:unknown`, 'unknown', 1);
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:unknown` } });
    const session = await receiving.start(arrival.id, actor as any);
    await receiving.receiveCarton(session.id, `CTN-${tag}-unknown-1`, actor as any, `op-${tag}-2`);

    const queue = await putaway.queue(200);
    const mine: any = queue.find((c: any) => c.externalCartonId === `CTN-${tag}-unknown-1`);
    expect(mine.sorting.kind).toBe('NEEDS_REVIEW');
  });

  // 10 ----------------------------------------------------------------
  it('CONFIRMED but unmapped category -> UNMAPPED, no destination invented', async () => {
    // Remove the mapping: resolution must degrade to UNMAPPED, not guess.
    await categories.removeZoneMapping(activeCatId, zoneId, { id: actor.id });
    const queue = await putaway.queue(200);
    const mine: any = queue.find((c: any) => c.externalCartonId === `CTN-${tag}-ok-1`);
    expect(mine.sorting.kind).toBe('UNMAPPED');
    // Restore for the placement test.
    await categories.setZoneMapping(activeCatId, zoneId, { id: actor.id });
  });

  // 10b ---------------------------------------------------------------
  it('manual category change: NEEDS_REVIEW resolved against the master, audited, rejects invalid input', async () => {
    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:unknown` } },
    });

    // Arbitrary text is rejected here exactly like at intake.
    await expect(
      arrivals.changeItemCategory(item.id, { category: `STILL-NOT-REAL-${tag}` }, { id: actor.id }),
    ).rejects.toBeDefined();
    // Inactive categories are rejected too.
    await expect(
      arrivals.changeItemCategory(item.id, { category: `LEGACY-${tag}` }, { id: actor.id }),
    ).rejects.toBeDefined();

    // Valid resolution -> CONFIRMED, source MANUAL, audit row.
    await arrivals.changeItemCategory(item.id, { category: `SHOES-${tag}`, subcategory: 'CASUAL' }, { id: actor.id });
    const after = await (prisma as any).expectedArrivalItem.findUnique({ where: { id: item.id } });
    expect(after.category).toBe(`SHOES-${tag}`);
    expect(after.subcategory).toBe('CASUAL');
    expect(after.classificationSource).toBe('MANUAL');
    expect(after.categoryStatus).toBe('CONFIRMED');
    expect(auditRows.some((r) => r.action === 'CATEGORY_MANUALLY_CHANGED')).toBe(true);

    // Open receiving snapshot follows the resolution.
    const rp = await (prisma as any).receivingProduct.findFirst({ where: { arrivalItemId: item.id } });
    expect(rp.category).toBe(`SHOES-${tag}`);
    expect(rp.categoryStatus).toBe('CONFIRMED');
  });

  // 11 ----------------------------------------------------------------
  it('category survives Putaway: carton stored on a location, decision audited', async () => {
    const pSession = await putaway.start(actor as any);
    const placed: any = await putaway.place(
      pSession.id,
      { cartonCode: `CTN-${tag}-ok-1`, locationCode },
      actor as any,
    );
    expect(placed.flash.kind).toBe('STORED');

    const carton = await (prisma as any).warehouseCarton.findFirst({
      where: { externalCartonId: `CTN-${tag}-ok-1` },
      include: { currentLocation: { include: { zone: true } } },
    });
    expect(carton.status).toBe('STORED');
    expect(carton.currentLocation.zone.code).toBe(`Z-${tag}`);

    // The category is still retrievable at the final stage via the chain
    // Carton -> Shipment -> Arrival -> Items.
    const full = await (prisma as any).warehouseCarton.findFirst({
      where: { externalCartonId: `CTN-${tag}-ok-1` },
      include: { shipment: { include: { expectedArrival: { include: { items: true } } } } },
    });
    expect(full.shipment.expectedArrival.items[0].category).toBe(`SHOES-${tag}`);
    expect(full.shipment.expectedArrival.items[0].categoryStatus).toBe('CONFIRMED');

    // Audit: destination decision recorded at placement time.
    const sel = auditRows.filter((r) => r.action === 'SORTING_DESTINATION_SELECTED');
    expect(sel.length).toBeGreaterThan(0);
    const last = sel[sel.length - 1];
    expect(last.metadata.configured_destination).toBe(`Z-${tag}`);
    expect(last.metadata.actual_zone).toBe(`Z-${tag}`);

    // Mapping mutations were audited too (configuration is traceable).
    expect(auditRows.some((r) => r.action === 'CATEGORY_MAPPING_SET')).toBe(true);
    expect(auditRows.some((r) => r.action === 'CATEGORY_MAPPING_REMOVED')).toBe(true);

    // Cleanup putaway session rows for this run.
    await (prisma as any).cartonPlacement.deleteMany({ where: { putawaySessionId: pSession.id } });
    await (prisma as any).putawaySession.delete({ where: { id: pSession.id } }).catch(() => {});
  });
});
