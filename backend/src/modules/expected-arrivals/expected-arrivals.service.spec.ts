import { BadRequestException } from '@nestjs/common';
import { ExpectedArrivalsService, type IntegrationPrincipal } from './expected-arrivals.service';

/**
 * Unit tests for the Arrival CRM -> Warehouse Expected Arrival receiver.
 * Prisma and Audit are stubbed in-memory so the logic (create, idempotency,
 * WAR code, audit) is verified without a live PostgreSQL instance.
 */

interface StoredArrival {
  id: string;
  code: string;
  customerArrivalCardId: string;
  arrivalId: string | null;
  arrivalReference: string | null;
  customerId: string;
  customerName: string;
  storeId: string | null;
  storeName: string | null;
  status: string;
  source: string;
  productCount: number;
  totalUnits: number;
  apiClientId: string | null;
  idempotencyKey: string | null;
  receivedViaApi: boolean;
  receivedViaApiAt: Date;
  createdAt: Date;
  updatedAt: Date;
  items: any[];
}

function makeMocks() {
  const rows: StoredArrival[] = [];
  const audits: any[] = [];
  let counter = 0;

  const txClient: any = {
    expectedArrival: {
      count: async () => rows.length,
      findUnique: async ({ where }: any) =>
        rows.find((r) =>
          (where.code && r.code === where.code) ||
          (where.customerArrivalCardId && r.customerArrivalCardId === where.customerArrivalCardId) ||
          (where.id && r.id === where.id),
        ) ?? null,
      create: async ({ data }: any) => {
        counter += 1;
        const row: StoredArrival = {
          id: `ea_${counter}`,
          code: data.code,
          customerArrivalCardId: data.customerArrivalCardId,
          arrivalId: data.arrivalId,
          arrivalReference: data.arrivalReference,
          customerId: data.customerId,
          customerName: data.customerName,
          storeId: data.storeId,
          storeName: data.storeName,
          status: data.status,
          source: data.source,
          productCount: data.productCount,
          totalUnits: data.totalUnits,
          apiClientId: data.apiClientId,
          idempotencyKey: data.idempotencyKey,
          receivedViaApi: data.receivedViaApi,
          receivedViaApiAt: data.receivedViaApiAt,
          createdAt: new Date(),
          updatedAt: new Date(),
          items: (data.items?.create ?? []).map((it: any, i: number) => ({ id: `it_${counter}_${i}`, ...it })),
        };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('row not found');
        const { items, ...fields } = data;
        Object.assign(row, fields);
        row.items.push(...(items?.create ?? []).map((it: any, i: number) => ({ id: `it_${row.id}_${row.items.length + i}`, ...it })));
        row.updatedAt = new Date();
        return row;
      },
      findFirst: async ({ where }: any) => {
        const card = where?.customerArrivalCardId;
        if (typeof card === 'string') return rows.find((r) => r.customerArrivalCardId === card) ?? null;
        if (card?.startsWith) return rows.find((r) => r.customerArrivalCardId.startsWith(card.startsWith) && (where.OR ?? []).some((clause: any) =>
          Object.entries(clause).some(([key, value]) => (r as any)[key] === value))) ?? null;
        const key = where?.idempotencyKey;
        if (key) return rows.find((r) => r.idempotencyKey === key) ?? null;
        return null;
      },
      findMany: async () => [...rows].sort((a, b) => +b.receivedViaApiAt - +a.receivedViaApiAt),
    },
      // Mock of the item relation used by the provisional-adoption mirror
      // (Bug B family): rows live on the arrival row's .items array.
      expectedArrivalItem: {
        findMany: async ({ where }: any) => {
          const row = rows.find((r) => r.id === where?.arrivalId);
          return row ? [...(row.items ?? [])] : [];
        },
        create: async ({ data }: any) => {
          const row = rows.find((r) => r.id === data?.arrivalId);
          const item = { id: `itx_${counter}_${(row?.items ?? []).length}`, ...data };
          row?.items?.push(item);
          return item;
        },
        updateMany: async ({ where, data }: any) => {
          let count = 0;
          for (const row of rows) {
            for (const it of row.items ?? []) {
              if (where?.id?.in?.includes(it.id)) { Object.assign(it, data); count += 1; }
            }
          }
          return { count };
        },
      },
  };

  const prisma: any = {
    ...txClient,
    // Category Master lookup used by intake validation. Empty master here:
    // any category on a card resolves to NEEDS_REVIEW in these unit tests.
    categoryMaster: { findMany: async () => [] },
    $transaction: async (fn: any) => fn(txClient),
  };

  const audit: any = {
    log: async (input: any) => {
      audits.push(input);
      return { id: `audit_${audits.length}` };
    },
  };

  // Auto-dispatch is a no-op in these unit tests (no worker/role tables in
  // the stub); the service only needs the seam to exist.
  const dispatched: any[] = [];
  const dispatch: any = {
    dispatch: async (taskKey: string, entity: any, _ctx: any) => {
      dispatched.push({ taskKey, entity });
      return null;
    },
  };

  return { prisma, audit, dispatch, dispatched, rows, audits };
}

function dto(over: any = {}) {
  return {
    event: 'customer_arrival_card.created',
    arrival: { id: 'ARR-JAN-2026-001', reference: 'JAN-2026-001' },
    customer_arrival_card: {
      id: 'CARD-ARR-2026-000145',
      customer: { id: 'CUS-001', name: 'Ahmed' },
      store: { id: 'STORE-SHEIN', name: 'SHEIN' },
      products: [
        { sku: 'SB-1', reference: 'SB-1', product_name: 'Product A', quantity: 1, variant: null, color: null, size: null },
        { sku: 'SB-2', reference: 'SB-2', product_name: 'Product B', quantity: 2, variant: 'V', color: 'Black', size: '42' },
      ],
      ...over,
    },
  } as any;
}

const principal: IntegrationPrincipal = { kind: 'static', id: null, name: 'ARRIVAL_CRM', idempotencyKey: null };

function pushMock(): any {
  return { notifyNewReceivingCard: jest.fn().mockResolvedValue(0) };
}

describe('ExpectedArrivalsService', () => {
  it('creates an EXPECTED arrival (not RECEIVED) from a customer card with products', async () => {
    const { prisma, audit, dispatch, dispatched, rows, audits } = makeMocks();
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());

    const res = await service.receiveCard(dto(), principal, '127.0.0.1');

    expect(res).toMatchObject({
      success: true,
      customer_arrival_card_id: 'CARD-ARR-2026-000145',
      status: 'EXPECTED',
      created: true,
    });
    expect(res.warehouse_arrival_id).toMatch(/^WAR-\d+$/);

    const stored = rows[0];
    expect(stored.status).toBe('EXPECTED');
    expect(stored.source).toBe('ARRIVAL_CRM');
    expect(stored.receivedViaApi).toBe(true);
    expect(stored.receivedViaApiAt).toBeInstanceOf(Date);
    expect(stored.productCount).toBe(2);
    expect(stored.totalUnits).toBe(3);
    expect(stored.customerName).toBe('Ahmed');
    expect(stored.storeName).toBe('SHEIN');
    // Master Order §3: a new arrival auto-dispatches the Receiving task.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].taskKey).toBe('receiving');
    expect(dispatched[0].entity.arrivalId).toBe(stored.id);
    expect(stored.items).toHaveLength(2);
    expect(stored.items[1]).toMatchObject({ sku: 'SB-2', quantity: 2, size: '42', color: 'Black' });

    // Audit row recorded in-transaction with the required event metadata.
    // (The category validation summary rows are asserted separately below.)
    const cardAudits = audits.filter((a) => a.action === 'CUSTOMER_ARRIVAL_CARD_RECEIVED');
    expect(cardAudits).toHaveLength(1);
    expect(cardAudits[0].metadata).toMatchObject({
      source: 'ARRIVAL_CRM',
      external_card_id: 'CARD-ARR-2026-000145',
      warehouse_arrival_id: stored.code,
      status: 'SUCCESS',
    });

    // Category validation trail: with an empty master, every line is
    // NEEDS_REVIEW — one summary row plus one explicit NEEDS_REVIEW row.
    const validated = audits.filter((a) => a.action === 'CATEGORY_VALIDATED');
    expect(validated).toHaveLength(1);
    expect(validated[0].metadata).toMatchObject({ confirmed: 0, needs_review: 2 });
    expect(audits.filter((a) => a.action === 'CATEGORY_NEEDS_REVIEW')).toHaveLength(1);
  });

  it('reconciles a shipment-first provisional arrival instead of splitting product and carton cards', async () => {
    const { prisma, audit, dispatch, dispatched, rows } = makeMocks();
    rows.push({
      id: 'ea-shipment-first', code: 'WAR-001234', customerArrivalCardId: 'shipment:SHP-001',
      arrivalId: 'ARR-JAN-2026-001', arrivalReference: 'JAN-2026-001', customerId: 'pending',
      customerName: 'Pending customer card', storeId: null, storeName: null, status: 'EXPECTED',
      source: 'ARRIVAL_CRM', productCount: 0, totalUnits: 0, apiClientId: null, idempotencyKey: null,
      receivedViaApi: true, receivedViaApiAt: new Date(), createdAt: new Date(), updatedAt: new Date(), items: [],
    });
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());

    const res = await service.receiveCard(dto(), principal);

    expect(res.created).toBe(true);
    expect(res.warehouse_arrival_id).toBe('WAR-001234');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'ea-shipment-first',
      customerArrivalCardId: 'CARD-ARR-2026-000145',
      customerName: 'Ahmed',
      productCount: 2,
      totalUnits: 3,
    });
    expect(rows[0].items).toHaveLength(2);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].entity.arrivalId).toBe('ea-shipment-first');
  });

  it('shipment-first adoption MIRRORS manifest rows — no double counting (Bug B family)', async () => {
    const { prisma, audit, dispatch, rows } = makeMocks();
    // Provisional shipment-backed arrival already holds MANIFEST rows for the
    // SAME SKUs the card will declare (SB-1 split 6 + 4 across two cartons,
    // SB-2 = 5). The card (10 + 5) is the authoritative expectation: adopting
    // it must not add duplicates that Receiving would aggregate twice.
    rows.push({
      id: 'ea-shipment-first', code: 'WAR-009999', customerArrivalCardId: 'shipment:SHP-001',
      arrivalId: 'ARR-REV-1', arrivalReference: 'REV-1', customerId: 'pending',
      customerName: 'Pending customer card', storeId: null, storeName: null, status: 'EXPECTED',
      source: 'ARRIVAL_CRM', productCount: 0, totalUnits: 0, apiClientId: null, idempotencyKey: null,
      receivedViaApi: true, receivedViaApiAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      items: [
        { id: 'm1', arrivalId: 'ea-shipment-first', cartonId: 'c1', sku: 'SB-1', productId: null, reference: 'SB-1', quantity: 6, category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW' },
        { id: 'm2', arrivalId: 'ea-shipment-first', cartonId: 'c2', sku: 'SB-1', productId: null, reference: 'SB-1', quantity: 4, category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW' },
        { id: 'm3', arrivalId: 'ea-shipment-first', cartonId: 'c2', sku: 'SB-2', productId: null, reference: 'SB-2', quantity: 5, category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW' },
      ],
    });
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const card: any = dto();
    card.arrival = { id: 'ARR-REV-1', reference: 'REV-1' };
    card.customer_arrival_card.id = 'CARD-REV-1';
    card.customer_arrival_card.products = [
      { sku: 'SB-1', product_name: 'Product A', quantity: 10, category: 'CLOTHING' },
      { sku: 'SB-2', product_name: 'Product B', quantity: 5, category: 'SHOES' },
    ];
    const res = await service.receiveCard(card, principal);
    expect(res.created).toBe(true);
    expect(res.warehouse_arrival_id).toBe('WAR-009999');
    expect(rows).toHaveLength(1);
    // Authoritative card totals stored on the arrival…
    expect(rows[0]).toMatchObject({ productCount: 2, totalUnits: 15 });
    // …but NO duplicate item rows: SB-1 still has exactly its 2 manifest rows.
    const items = rows[0].items as any[];
    expect(items.filter((i) => i.sku === 'SB-1')).toHaveLength(2);
    expect(items.filter((i) => i.sku === 'SB-2')).toHaveLength(1);
    // Manifest rows are backfilled with the card's classification so Receiving
    // never re-verifies them as unclassified.
    expect(items.find((i) => i.id === 'm1')).toMatchObject({ category: 'CLOTHING', categoryStatus: 'NEEDS_REVIEW' });
    expect(items.find((i) => i.id === 'm2')).toMatchObject({ category: 'CLOTHING' });
    expect(items.find((i) => i.id === 'm3')).toMatchObject({ category: 'SHOES' });
  });

  it('shipment-first adoption TOP-UPS when the card declares more than the manifest rows', async () => {
    const { prisma, audit, dispatch, rows } = makeMocks();
    rows.push({
      id: 'ea-topup', code: 'WAR-010000', customerArrivalCardId: 'shipment:SHP-002',
      arrivalId: 'ARR-REV-2', arrivalReference: 'REV-2', customerId: 'pending',
      customerName: 'Pending customer card', storeId: null, storeName: null, status: 'EXPECTED',
      source: 'ARRIVAL_CRM', productCount: 0, totalUnits: 0, apiClientId: null, idempotencyKey: null,
      receivedViaApi: true, receivedViaApiAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
      items: [
        { id: 't1', arrivalId: 'ea-topup', cartonId: 'c1', sku: 'SB-1', productId: null, reference: 'SB-1', quantity: 6, category: null, subcategory: null, categoryStatus: 'NEEDS_REVIEW' },
      ],
    });
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const card: any = dto();
    card.arrival = { id: 'ARR-REV-2', reference: 'REV-2' };
    card.customer_arrival_card.id = 'CARD-REV-2';
    card.customer_arrival_card.products = [
      { sku: 'SB-1', product_name: 'Product A', quantity: 10, category: 'CLOTHING' },
      { sku: 'SB-2', product_name: 'Product B', quantity: 5, category: 'SHOES' },
    ];
    await service.receiveCard(card, principal);
    const items = rows[0].items as any[];
    // SB-1: manifest 6 + ONE arrival-level top-up row of 4 = 10 (card ceiling).
    const sb1 = items.filter((i) => i.sku === 'SB-1');
    expect(sb1).toHaveLength(2);
    const extra = sb1.find((i) => i.id !== 't1');
    expect(extra).toMatchObject({ quantity: 4, category: 'CLOTHING' });
    // SB-2: not on any manifest -> created normally.
    const sb2 = items.filter((i) => i.sku === 'SB-2');
    expect(sb2).toHaveLength(1);
    expect(sb2[0].quantity).toBe(5);
    expect(rows[0].totalUnits).toBe(15);
  });

  it('is idempotent: a double send of the same card returns the SAME Expected Arrival', async () => {
    const { prisma, audit, dispatch, dispatched, rows, audits } = makeMocks();
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());

    const first = await service.receiveCard(dto(), { ...principal, idempotencyKey: 'CARD-ARR-2026-000145' });
    const second = await service.receiveCard(dto(), { ...principal, idempotencyKey: 'CARD-ARR-2026-000145' });

    expect(first.warehouse_arrival_id).toBe(second.warehouse_arrival_id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(rows).toHaveLength(1);
    // Card audit only on actual creation (replays add nothing).
    expect(audits.filter((a) => a.action === 'CUSTOMER_ARRIVAL_CARD_RECEIVED')).toHaveLength(1);
    // Auto-dispatch only on actual creation — the replay reuses the arrival.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].taskKey).toBe('receiving');
  });

  it('rejects a card with no products without creating a partial record', async () => {
    const { prisma, audit, dispatch, dispatched, rows, audits } = makeMocks();
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const empty = dto({ products: [] });

    await expect(service.receiveCard(empty, principal)).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('handles a large card (100 products) and aggregates units', async () => {
    const { prisma, audit, dispatch, dispatched, rows, audits } = makeMocks();
    const service = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const big = dto({
      products: Array.from({ length: 100 }, (_, i) => ({
        sku: `SKU-${i + 1}`,
        reference: `REF-${i + 1}`,
        product_name: `Product ${i + 1}`,
        quantity: 1,
        variant: null,
        color: null,
        size: null,
      })),
    });
    const res = await service.receiveCard(big, principal);
    expect(res.status).toBe('EXPECTED');
    expect(rows[0].productCount).toBe(100);
    expect(rows[0].totalUnits).toBe(100);
    expect(rows[0].items).toHaveLength(100);
  });
});
