import { PrismaClient } from '@prisma/client';
import { ExpectedArrivalsService } from '../src/modules/expected-arrivals/expected-arrivals.service';
import { ReceivingService } from '../src/modules/receiving/receiving.service';
import { PutawayService } from '../src/modules/putaway/putaway.service';
import { CategoriesService } from '../src/modules/categories/categories.service';

/**
 * CURRENT CARD + CATEGORY — end-to-end (service layer, real Postgres).
 *
 * The Arrival CRM now includes `category` on each product of the EXISTING
 * Customer Arrival Card. These tests prove the category:
 *  - is accepted and persisted (normalized UPPERCASE),
 *  - is optional (legacy cards without it keep working — NULL, no failure),
 *  - flows Card -> ExpectedArrivalItem -> ReceivingProduct without loss,
 *  - NULL surfaces as UNKNOWN downstream (never guessed),
 *  - never breaks the existing idempotency (duplicate card / carton),
 *  - rides with the carton into the putaway/sorting queue.
 *
 * Requires a migrated database: DATABASE_URL=... npm run test:e2e
 */
describe('CURRENT CARD + CATEGORY', () => {
  let prisma: PrismaClient;
  let arrivals: ExpectedArrivalsService;
  let receiving: ReceivingService;
  let putaway: PutawayService;
  const tag = `CATE2E-${Date.now()}`;

  const principal = { kind: 'static' as const, id: null, name: 'e2e-crm', idempotencyKey: null };
  const actor = { id: `user-${tag}`, name: 'Supervisor', canResolveDiscrepancy: true, ip: null };
  const noAudit = { log: async () => {} } as any;

  const cardEvent = (suffix: string, products: any[]) => ({
    event: 'customer_arrival_card.created' as const,
    arrival: { id: `ARR-${tag}-${suffix}`, reference: null },
    customer_arrival_card: {
      id: `card:${tag}:${suffix}`,
      customer: { id: `cust-${tag}`, name: `Cat E2E ${suffix}` },
      store: { id: 'STORE-E2E', name: 'E2E STORE' },
      products,
    },
  });

  beforeAll(async () => {
    prisma = new PrismaClient();
    arrivals = new ExpectedArrivalsService(prisma as any, noAudit);
    receiving = new ReceivingService(prisma as any, noAudit);
    putaway = new PutawayService(prisma as any, noAudit, new CategoriesService(prisma as any, noAudit));
  });

  afterAll(async () => {
    await (prisma as any).receivingDiscrepancy.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: { startsWith: `card:${tag}` } } } } });
    await (prisma as any).receivingCarton.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: { startsWith: `card:${tag}` } } } } });
    await (prisma as any).receivingProduct.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: { startsWith: `card:${tag}` } } } } });
    await (prisma as any).receivingSession.deleteMany({ where: { expectedArrival: { customerArrivalCardId: { startsWith: `card:${tag}` } } } });
    await (prisma as any).warehouseCarton.deleteMany({ where: { externalCartonId: { startsWith: `CTN-${tag}` } } });
    await (prisma as any).warehouseShipment.deleteMany({ where: { externalShipmentId: { startsWith: `SHP-${tag}` } } });
    await (prisma as any).expectedArrivalItem.deleteMany({ where: { arrival: { customerArrivalCardId: { startsWith: `card:${tag}` } } } });
    await (prisma as any).expectedArrival.deleteMany({ where: { customerArrivalCardId: { startsWith: `card:${tag}` } } });
    await prisma.$disconnect();
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

  // ------------------------------------------------------------------
  // 1. Card WITH category -> persisted, normalized UPPERCASE
  // ------------------------------------------------------------------
  it('persists category from the card (normalized UPPERCASE)', async () => {
    const res = await arrivals.receiveCard(
      cardEvent('with', [
        { sku: `SKU-${tag}-A`, product_name: 'Basket', quantity: 3, category: 'shoes' },
        { sku: `SKU-${tag}-B`, product_name: 'Robe', quantity: 2, category: 'CLOTHING' },
      ]) as any,
      principal,
    );
    expect(res.created).toBe(true);

    const items = await (prisma as any).expectedArrivalItem.findMany({
      where: { arrival: { customerArrivalCardId: `card:${tag}:with` } },
      orderBy: { sku: 'asc' },
    });
    expect(items.map((i: any) => i.category)).toEqual(['SHOES', 'CLOTHING']);
  });

  // ------------------------------------------------------------------
  // 2. Legacy card WITHOUT category -> accepted, category = NULL
  // ------------------------------------------------------------------
  it('legacy card without category still works (category NULL, no failure)', async () => {
    const res = await arrivals.receiveCard(
      cardEvent('legacy', [{ sku: `SKU-${tag}-L`, product_name: 'Old product', quantity: 1 }]) as any,
      principal,
    );
    expect(res.created).toBe(true);

    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:legacy` } },
    });
    expect(item.category).toBeNull();
  });

  // ------------------------------------------------------------------
  // 3. Empty-string category -> NULL, never a blank value
  // ------------------------------------------------------------------
  it('empty/whitespace category is stored as NULL (UNKNOWN), never guessed', async () => {
    await arrivals.receiveCard(
      cardEvent('empty', [{ sku: `SKU-${tag}-E`, product_name: 'Chaussure de sport', quantity: 1, category: '   ' }]) as any,
      principal,
    );
    const item = await (prisma as any).expectedArrivalItem.findFirst({
      where: { arrival: { customerArrivalCardId: `card:${tag}:empty` } },
    });
    // "Chaussure" would tempt a name-based guess of SHOES — must stay NULL.
    expect(item.category).toBeNull();
  });

  // ------------------------------------------------------------------
  // 4. Duplicate card replay -> same arrival, no duplicate items
  // ------------------------------------------------------------------
  it('duplicate card replay stays idempotent with category present', async () => {
    const again = await arrivals.receiveCard(
      cardEvent('with', [
        { sku: `SKU-${tag}-A`, product_name: 'Basket', quantity: 3, category: 'shoes' },
        { sku: `SKU-${tag}-B`, product_name: 'Robe', quantity: 2, category: 'CLOTHING' },
      ]) as any,
      principal,
    );
    expect(again.created).toBe(false); // replay, not a new record

    const count = await (prisma as any).expectedArrivalItem.count({
      where: { arrival: { customerArrivalCardId: `card:${tag}:with` } },
    });
    expect(count).toBe(2); // items not duplicated
  });

  // ------------------------------------------------------------------
  // 5. Card -> Receiving: category snapshot lands on ReceivingProduct
  // ------------------------------------------------------------------
  it('category flows into the receiving session products (no loss)', async () => {
    await attachShipment(`card:${tag}:with`, 'with', 2);
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:with` } });

    const session = await receiving.start(arrival.id, actor as any);
    const bySku = Object.fromEntries(session.products.map((p: any) => [p.sku, p.category]));
    expect(bySku[`SKU-${tag}-A`]).toBe('SHOES');
    expect(bySku[`SKU-${tag}-B`]).toBe('CLOTHING');
  });

  // ------------------------------------------------------------------
  // 6. UNKNOWN case surfaces as null on the session (UI renders UNKNOWN)
  // ------------------------------------------------------------------
  it('missing category surfaces as null on the receiving line (UI shows UNKNOWN)', async () => {
    await attachShipment(`card:${tag}:legacy`, 'legacy', 1);
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:legacy` } });

    const session = await receiving.start(arrival.id, actor as any);
    expect(session.products[0].category).toBeNull();
  });

  // ------------------------------------------------------------------
  // 7. Duplicate carton scan still no-double-counts with category present
  // ------------------------------------------------------------------
  it('carton receive + duplicate scan keep existing idempotency', async () => {
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:with` } });
    const session = await (prisma as any).receivingSession.findFirst({ where: { arrivalId: arrival.id, status: 'RECEIVING' } });

    const first = await receiving.receiveCarton(session.id, `CTN-${tag}-with-1`, actor as any, `op-${tag}-1`);
    expect(first.tally.receivedCartons).toBe(1);

    // Same carton again -> DUPLICATE flash, count unchanged.
    const dup = await receiving.scanCarton(session.id, `CTN-${tag}-with-1`, 'MANUAL', actor as any, `op-${tag}-2`);
    expect(dup.flash?.kind).toBe('DUPLICATE_CARTON');
    expect(dup.tally.receivedCartons).toBe(1);
  });

  // ------------------------------------------------------------------
  // 8. Sorting readiness: putaway queue carries the categories
  // ------------------------------------------------------------------
  it('received carton enters the putaway/sorting queue WITH its categories', async () => {
    const queue = await putaway.queue(200);
    const mine = queue.find((c: any) => c.externalCartonId === `CTN-${tag}-with-1`);
    expect(mine).toBeDefined();
    expect((mine as any).categories.sort()).toEqual(['CLOTHING', 'SHOES']);
  });

  it('legacy carton appears in the queue with UNKNOWN category', async () => {
    const arrival = await (prisma as any).expectedArrival.findUnique({ where: { customerArrivalCardId: `card:${tag}:legacy` } });
    const session = await (prisma as any).receivingSession.findFirst({ where: { arrivalId: arrival.id, status: 'RECEIVING' } });
    await receiving.receiveCarton(session.id, `CTN-${tag}-legacy-1`, actor as any, `op-${tag}-3`);

    const queue = await putaway.queue(200);
    const mine = queue.find((c: any) => c.externalCartonId === `CTN-${tag}-legacy-1`);
    expect(mine).toBeDefined();
    expect((mine as any).categories).toEqual(['UNKNOWN']);
  });
});
