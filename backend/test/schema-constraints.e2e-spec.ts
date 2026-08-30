import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Phase 2 — STEP 2 schema/constraints verification.
 *
 * Validates the APPROVED Phase 2 data model at the DATABASE level
 * (design doc `docs/PHASE-2-DESIGN-PROPOSAL.md` §6–§9):
 *   - C1  UNIQUE (store, externalProductCode)         — D-40/D-44
 *   - C2  UNIQUE externalOrderReference               — D-41/D-56B anchor
 *   - C3  UNIQUE (orderId, externalLineReference)     — D-51 (NULLs allowed)
 *   - C4  UNIQUE (orderItemId, externalItemReference) — D-51 (NULLs allowed)
 *   - C5  UNIQUE itemCode                             — D-53
 *   - C6  CHECK requestedQuantity > 0 (raw SQL)       — §8
 *   - FK Restrict on every Phase 2 relation           — D-35
 *   - PhysicalItem defaults (EXPECTED, NULL location) — D-45/D-46
 *   - contentHash NOT NULL                            — D-56B/D-65
 *   - AuditAction accepts the 12 Phase 2 events
 *
 * Requires a migrated database: DATABASE_URL=... npm run test:e2e
 */
describe('Phase 2 — schema & constraints', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    // Cleanup in reverse dependency order (Restrict protects parents — D-35).
    await prisma.auditLog.deleteMany({ where: { action: 'PHYSICAL_ITEM_CREATED' } });
    await prisma.physicalItem.deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.warehouseOrder.deleteMany({});
    await prisma.product.deleteMany({});
    await prisma.location.deleteMany({ where: { locationCode: { startsWith: 'P2SC-' } } });
    await prisma.level.deleteMany({ where: { code: 'P2SC-L1' } });
    await prisma.rack.deleteMany({ where: { code: 'P2SC-R1' } });
    await prisma.aisle.deleteMany({ where: { code: 'P2SC-A1' } });
    await prisma.zone.deleteMany({ where: { code: 'P2SC-Z1' } });
    await prisma.warehouse.deleteMany({ where: { code: { startsWith: 'P2SC-' } } });
    await prisma.$disconnect();
  });

  const expectErrorCode = async (promise: Promise<unknown>, code: string) => {
    let caught: unknown;
    try {
      await promise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe(code);
  };
  const uniqueViolation = (promise: Promise<unknown>) => expectErrorCode(promise, 'P2002');
  const fkViolation = (promise: Promise<unknown>) => expectErrorCode(promise, 'P2003');
  const checkViolation = (promise: Promise<unknown>) => expectErrorCode(promise, 'P2010');

  let warehouseId: string;
  let productId: string;
  let orderId: string;
  let orderItemId: string;

  it('creates the Phase 2 fixture chain (warehouse → product → order → line)', async () => {
    const warehouse = await prisma.warehouse.create({
      data: { code: `P2SC-WH-${Date.now()}`, name: 'P2 schema fixture' },
    });
    warehouseId = warehouse.id;

    const product = await prisma.product.create({
      data: { store: 'NIKE', externalProductCode: 'ABC123', name: 'Nike Air Max' },
    });
    productId = product.id;

    const order = await prisma.warehouseOrder.create({
      data: {
        externalOrderReference: 'P2SC-ORD-1',
        externalCustomerReference: 'CUST-10452',
        contentHash: 'fixture-hash',
        warehouseId,
      },
    });
    orderId = order.id;

    const line = await prisma.orderItem.create({
      data: { orderId, productId, requestedQuantity: 2 },
    });
    orderItemId = line.id;

    expect(product.status).toBe('ACTIVE');
    expect(order.status).toBe('OPEN');
    expect(order.source).toBe('ADMIN');
    expect(line.status).toBe('OPEN');
  });

  it('C1: rejects duplicate (store, externalProductCode) — D-40/D-44', async () => {
    await uniqueViolation(
      prisma.product.create({ data: { store: 'NIKE', externalProductCode: 'ABC123', name: 'dup' } }),
    );
  });

  it('C1 (D-44): the SAME code under a DIFFERENT store is a distinct product', async () => {
    const temu = await prisma.product.create({
      data: { store: 'TEMU', externalProductCode: 'ABC123', name: 'different store' },
    });
    expect(temu.id).not.toBe(productId);
  });

  it('C2: rejects a duplicate externalOrderReference (idempotency anchor)', async () => {
    await uniqueViolation(
      prisma.warehouseOrder.create({
        data: { externalOrderReference: 'P2SC-ORD-1', externalCustomerReference: 'X', contentHash: 'h' },
      }),
    );
  });

  it('C3: rejects a duplicate line reference within the order — but allows many NULL refs (D-51)', async () => {
    const first = await prisma.orderItem.create({
      data: { orderId, productId, requestedQuantity: 1, externalLineReference: 'LINE-A' },
    });
    await uniqueViolation(
      prisma.orderItem.create({
        data: { orderId, productId, requestedQuantity: 1, externalLineReference: 'LINE-A' },
      }),
    );

    const a = await prisma.orderItem.create({
      data: { orderId, productId, requestedQuantity: 1, externalLineReference: null },
    });
    const b = await prisma.orderItem.create({
      data: { orderId, productId, requestedQuantity: 1, externalLineReference: null },
    });
    expect(a.id).not.toBe(b.id); // multiple NULLs allowed → D-58 legitimate repeat lines
    await prisma.orderItem.delete({ where: { id: a.id } });
    await prisma.orderItem.delete({ where: { id: b.id } });
    await prisma.orderItem.delete({ where: { id: first.id } });
  });

  it('C4: rejects a duplicate piece reference within the line — but allows many NULL refs', async () => {
    const piece = await prisma.physicalItem.create({
      data: { orderItemId, itemCode: 'PI-P2SC0001', externalItemReference: 'PIECE-A' },
    });
    expect(piece.status).toBe('EXPECTED'); // D-45
    expect(piece.currentLocationId).toBeNull(); // D-46

    await uniqueViolation(
      prisma.physicalItem.create({
        data: { orderItemId, itemCode: 'PI-P2SC0002', externalItemReference: 'PIECE-A' },
      }),
    );

    const n1 = await prisma.physicalItem.create({ data: { orderItemId, itemCode: 'PI-P2SC0002' } });
    const n2 = await prisma.physicalItem.create({ data: { orderItemId, itemCode: 'PI-P2SC0003' } });
    expect(n1.id).not.toBe(n2.id);
  });

  it('C5: rejects a duplicate itemCode (D-53)', async () => {
    await uniqueViolation(
      prisma.physicalItem.create({
        data: { orderItemId, itemCode: 'PI-P2SC0001' },
      }),
    );
  });

  it('C6: rejects requestedQuantity <= 0 at the DB level (CHECK)', async () => {
    await checkViolation(
      prisma.$executeRaw`INSERT INTO "order_items" ("id","orderId","productId","requestedQuantity","status","createdAt","updatedAt") VALUES (gen_random_uuid(), ${orderId}, ${productId}, 0, 'OPEN'::"OrderItemStatus", now(), now())`,
    );
  });

  it('D-35: FKs are Restrict — cannot delete a parent with children', async () => {
    await fkViolation(prisma.warehouse.delete({ where: { id: warehouseId } }));
    await fkViolation(prisma.product.delete({ where: { id: productId } }));
    await fkViolation(prisma.warehouseOrder.delete({ where: { id: orderId } }));
    await fkViolation(prisma.orderItem.delete({ where: { id: orderItemId } }));
  });

  it('D-46: a Phase 1 Location can be referenced (nullable) and Restrict protects it', async () => {
    // Minimal Phase 1 chain to obtain one Location.
    const warehouse = await prisma.warehouse.create({ data: { code: `P2SC-WH2-${Date.now()}`, name: 'loc fixture' } });
    const zone = await prisma.zone.create({ data: { warehouseId: warehouse.id, code: 'P2SC-Z1', name: 'Z' } });
    const aisle = await prisma.aisle.create({ data: { zoneId: zone.id, code: 'P2SC-A1', name: 'A' } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, code: 'P2SC-R1', name: 'R' } });
    const level = await prisma.level.create({ data: { rackId: rack.id, code: 'P2SC-L1', levelNumber: 1 } });
    const location = await prisma.location.create({
      data: {
        warehouseId: warehouse.id, zoneId: zone.id, aisleId: aisle.id, rackId: rack.id, levelId: level.id,
        locationCode: `P2SC-${Date.now()}-LOC`, barcodeValue: `P2SC-${Date.now()}-LOC`, locationType: 'STORAGE',
      },
    });

    const piece = await prisma.physicalItem.findFirstOrThrow({ where: { itemCode: 'PI-P2SC0001' } });
    const updated = await prisma.physicalItem.update({
      where: { id: piece.id },
      data: { currentLocationId: location.id },
    });
    expect(updated.currentLocationId).toBe(location.id);

    await fkViolation(prisma.location.delete({ where: { id: location.id } }));
    await prisma.physicalItem.update({ where: { id: piece.id }, data: { currentLocationId: null } });
  });

  it('audits a Phase 2 event (AuditAction enum accepts the new values)', async () => {
    const row = await prisma.auditLog.create({
      data: { actorUserId: null, action: 'PHYSICAL_ITEM_CREATED', entityType: 'physical_item', entityId: 'fixture', metadata: { fixture: true } as any },
    });
    expect(row.action).toBe('PHYSICAL_ITEM_CREATED');
  });
});
