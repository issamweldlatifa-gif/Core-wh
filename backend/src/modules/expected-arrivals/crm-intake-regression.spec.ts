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
      findFirst: async ({ where, orderBy }: any) => {
        // Highest-code lookup used by the WAR sequence generator.
        if (where?.code?.startsWith && orderBy?.code === 'desc') {
          const prefix = where.code.startsWith;
          const matching = rows
            .filter((r) => r.code.startsWith(prefix))
            .sort((a, b) => (a.code < b.code ? 1 : a.code > b.code ? -1 : 0));
          return matching[0] ?? null;
        }
        const card = where?.customerArrivalCardId;
        if (typeof card === 'string') return rows.find((r) => r.customerArrivalCardId === card) ?? null;
        if (card?.startsWith) return rows.find((r) => r.customerArrivalCardId.startsWith(card.startsWith) && (where.OR ?? []).some((clause: any) =>
          Object.entries(clause).some(([key, value]) => (r as any)[key] === value))) ?? null;
        const key = where?.idempotencyKey;
        if (key) return rows.find((r) => r.idempotencyKey === key
          && (where.customerArrivalCardId === undefined || r.customerArrivalCardId === where.customerArrivalCardId)) ?? null;
        return null;
      },
      findMany: async () => [...rows].sort((a, b) => +b.receivedViaApiAt - +a.receivedViaApiAt),
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


/**
 * REGRESSION — "one card arrived, then the feed went silent".
 *
 * A CRM that reuses a single Idempotency-Key for every request (a very common
 * HTTP client default) had its first Customer Arrival Card stored, and every
 * later card silently resolved to that first arrival: success:true,
 * created:false, nothing new in Admin Web, no card in the Worker app.
 * The key must only suppress a replay of the SAME card id.
 */
function pushMock(): any {
  return { notifyNewReceivingCard: jest.fn().mockResolvedValue(0) };
}

describe('CRM intake — idempotency key must be scoped to the card', () => {
  it('stores every distinct card even when one Idempotency-Key is reused', async () => {
    const { prisma, audit, dispatch, rows } = makeMocks();
    const svc = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const p = { ...principal, idempotencyKey: 'one-key-for-everything' };

    const r1 = await svc.receiveCard(dto({ id: 'CARD-1' }), p as any);
    const r2 = await svc.receiveCard(dto({ id: 'CARD-2' }), p as any);
    const r3 = await svc.receiveCard(dto({ id: 'CARD-3' }), p as any);

    expect([r1.created, r2.created, r3.created]).toEqual([true, true, true]);
    expect(rows.map((r: any) => r.customerArrivalCardId)).toEqual(['CARD-1', 'CARD-2', 'CARD-3']);
    // distinct human codes, so Admin Web lists three separate arrivals
    expect(new Set([r1.warehouse_arrival_id, r2.warehouse_arrival_id, r3.warehouse_arrival_id]).size).toBe(3);
  });

  it('still suppresses a true replay of the same card with the same key', async () => {
    const { prisma, audit, dispatch, rows } = makeMocks();
    const svc = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const p = { ...principal, idempotencyKey: 'retry-key' };
    const first = await svc.receiveCard(dto({ id: 'CARD-9' }), p as any);
    const replay = await svc.receiveCard(dto({ id: 'CARD-9' }), p as any);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.warehouse_arrival_id).toBe(first.warehouse_arrival_id);
    expect(rows).toHaveLength(1);
  });
});

/**
 * REGRESSION — WAR code sequence must survive a deletion.
 *
 * The generator numbered codes as count()+1. After an arrival was deleted or
 * force-deleted the next number pointed at an already-taken code, and because
 * every retry recomputed the identical number the loop could never escape:
 * intake fell back to a random WAR-R… code (or collided outright).
 */
describe('WAR code generation after deletions', () => {
  it('continues past the highest existing code instead of colliding', async () => {
    const { prisma, audit, dispatch, rows } = makeMocks();
    const svc = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const p = { ...principal, idempotencyKey: null };

    await svc.receiveCard(dto({ id: 'CARD-1' }), p as any); // WAR-001001
    await svc.receiveCard(dto({ id: 'CARD-2' }), p as any); // WAR-001002
    // Admin force-deletes the FIRST arrival: one row left, and it is 001002.
    const idx = rows.findIndex((r: any) => r.customerArrivalCardId === 'CARD-1');
    rows.splice(idx, 1);

    const next = await svc.receiveCard(dto({ id: 'CARD-3' }), p as any);
    // Sequential and unique — never a WAR-R… fallback.
    expect(next.warehouse_arrival_id).toBe('WAR-001003');
    expect(next.created).toBe(true);
  });

  it('keeps issuing sequential codes across several deletions', async () => {
    const { prisma, audit, dispatch, rows } = makeMocks();
    const svc = new ExpectedArrivalsService(prisma, audit, dispatch, pushMock());
    const p = { ...principal, idempotencyKey: null };
    const issued: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const r = await svc.receiveCard(dto({ id: `C-${i}` }), p as any);
      issued.push(r.warehouse_arrival_id);
      rows.splice(0, rows.length - 1); // keep only the newest row
    }
    expect(issued).toEqual(['WAR-001001', 'WAR-001002', 'WAR-001003', 'WAR-001004']);
    // none of them degraded to the random WAR-R… fallback
    expect(issued.every((c) => /^WAR-\d{6}$/.test(c))).toBe(true);
  });
});
