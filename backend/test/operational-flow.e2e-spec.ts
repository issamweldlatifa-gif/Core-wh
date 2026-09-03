import { PrismaClient } from '@prisma/client';
import { ExpectedArrivalsService } from '../src/modules/expected-arrivals/expected-arrivals.service';
import { ReceivingService } from '../src/modules/receiving/receiving.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { FulfillmentService } from '../src/modules/fulfillment/fulfillment.service';
import { OrdersService } from '../src/modules/orders/orders.service';

/**
 * OPERATIONAL WAREHOUSE FLOW — full chain on a real Postgres:
 *
 *   CRM Card -> Receiving session -> ARTICLE scan into a RECEIVING tote ->
 *   Sorting (configured destination) -> STORED at location ->
 *   Order intake (idempotent) -> customer BIN -> order sorting with
 *   error prevention -> READY_FOR_PACKING -> packing verification ->
 *   outbound shipment -> SHIPPED -> container cleanup + traceability.
 *
 * Matrix:
 *   1.  receiving article scan creates a traceable ArticleUnit in the tote
 *   2.  unexpected SKU -> UNEXPECTED_ARTICLE + OPEN discrepancy (admin exception)
 *   3.  scan into a CUSTOMER container at receiving is rejected
 *   4.  sorting scan resolves the CONFIGURED destination + suggests locations
 *   5.  storing into the wrong zone is rejected (409)
 *   6.  storing into the right zone -> STORED + location recorded
 *   7.  NEEDS_REVIEW article is blocked from storage
 *   8.  order intake is idempotent (replay -> UNCHANGED)
 *   9.  customer bin carries the customer label; duplicate bin rejected
 *   10. order-sorting scan shows PRODUCT -> CUSTOMER -> BIN
 *   11. wrong bin (other customer) is rejected; unneeded article rejected
 *   12. completing the order flips the bin to READY_FOR_PACKING
 *   13. packing an incomplete bin is rejected; complete bin -> outbound
 *       shipment READY_TO_SHIP with internal label, NULL tracking (no carrier)
 *   14. shipping scan + dispatch -> SHIPPED, articles SHIPPED, bin CLOSED,
 *       audit trail intact (nothing deleted)
 *   15. articleTrace returns the full chain
 */
describe('OPERATIONAL FLOW — receiving tote -> sorting -> bin -> pack -> ship', () => {
  jest.setTimeout(60000);
  let prisma: PrismaClient;
  let arrivals: ExpectedArrivalsService;
  let receiving: ReceivingService;
  let categories: CategoriesService;
  let fulfillment: FulfillmentService;
  let orders: OrdersService;
  const tag = `FLOW${Date.now()}`;

  const principal = { kind: 'static' as const, id: null, name: 'e2e-crm', idempotencyKey: null };
  const actor = { id: '', name: 'E2E Worker', canResolveDiscrepancy: true, ip: null };
  const auditRows: any[] = [];
  const captureAudit = {
    log: async (entry: any, tx?: any) => {
      auditRows.push(entry);
      const client = tx ?? prisma;
      return (client as any).auditLog.create({
        data: {
          actorUserId: null, // e2e actor ids are not FK-safe for every case
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          metadata: entry.metadata ?? null,
        },
      });
    },
  } as any;

  let warehouseId = '';
  let zoneId = '';
  let wrongZoneId = '';
  let locationCode = '';
  let wrongLocationCode = '';
  let sessionId = '';
  let toteCode = '';
  let articleCode = '';
  let article2Code = '';
  let binCode = '';
  let outCode = '';

  const SKU = `SKU-${tag}-A`;
  const CAT = `FLOWCAT-${tag}`;

  beforeAll(async () => {
    prisma = new PrismaClient();
    arrivals = new ExpectedArrivalsService(prisma as any, captureAudit);
    receiving = new ReceivingService(prisma as any, captureAudit);
    categories = new CategoriesService(prisma as any, captureAudit);
    fulfillment = new FulfillmentService(prisma as any, captureAudit, categories);
    orders = new OrdersService(prisma as any, captureAudit);

    const worker = await (prisma as any).user.create({
      data: { name: 'E2E Flow Worker', employeeCode: `E2E-${tag}` },
    });
    actor.id = worker.id;

    // Category + two zones (right + wrong) + configured mapping.
    const cat = await (prisma as any).categoryMaster.create({
      data: { code: CAT, name: 'Flow cat', subcategories: ['SPORTS'] },
    });
    const wh = await (prisma as any).warehouse.create({ data: { code: `WH-${tag}`, name: 'E2E WH' } });
    warehouseId = wh.id;
    const mkTree = async (zc: string) => {
      const zone = await (prisma as any).zone.create({ data: { warehouseId, code: zc, name: zc } });
      const aisle = await (prisma as any).aisle.create({ data: { zoneId: zone.id, code: 'A01', name: 'A01' } });
      const rack = await (prisma as any).rack.create({ data: { aisleId: aisle.id, code: 'R01', name: 'R01' } });
      const level = await (prisma as any).level.create({ data: { rackId: rack.id, code: 'L01', levelNumber: 1 } });
      const code = `LOC-${tag}-${zc}`;
      await (prisma as any).location.create({
        data: {
          warehouseId, zoneId: zone.id, aisleId: aisle.id, rackId: rack.id, levelId: level.id,
          locationCode: code, barcodeValue: code, locationType: 'STORAGE', status: 'ACTIVE',
        },
      });
      return { zoneId: zone.id, code };
    };
    const right = await mkTree(`ZR-${tag.slice(-4)}`);
    const wrong = await mkTree(`ZW-${tag.slice(-4)}`);
    zoneId = right.zoneId; locationCode = right.code;
    wrongZoneId = wrong.zoneId; wrongLocationCode = wrong.code;
    await (prisma as any).categoryZoneMapping.create({ data: { categoryId: cat.id, zoneId } });

    // CRM card -> expected arrival with 2 units of SKU (CONFIRMED category).
    await arrivals.receiveCard(
      {
        event: 'customer_arrival_card.created',
        arrival: { id: `ARR-${tag}`, reference: null },
        customer_arrival_card: {
          id: `card:${tag}`,
          customer: { id: `cust-${tag}`, name: 'Flow Customer' },
          store: { id: 'STORE-E2E', name: 'E2E STORE' },
          products: [
            { sku: SKU, product_name: 'Flow Sneaker', quantity: 2, category: CAT.toLowerCase(), subcategory: 'sports', classification_source: 'AI' },
          ],
        },
      } as any,
      principal,
    );
    const arrivalRow = await (prisma as any).expectedArrival.findUnique({
      where: { customerArrivalCardId: `card:${tag}` },
    });
    const session = await receiving.start(arrivalRow.id, actor as any);
    sessionId = session.id;
  });

  afterAll(async () => {
    await (prisma as any).articleUnit.deleteMany({ where: { code: { contains: '' }, receivingSession: { expectedArrival: { customerArrivalCardId: `card:${tag}` } } } });
    await (prisma as any).outboundShipment.deleteMany({ where: { order: { externalOrderReference: { startsWith: `ORD-${tag}` } } } });
    await (prisma as any).operationalContainer.deleteMany({ where: { OR: [{ order: { externalOrderReference: { startsWith: `ORD-${tag}` } } }, { code: toteCode }] } });
    await (prisma as any).articleUnit.deleteMany({ where: { sku: { startsWith: `SKU-${tag}` } } });
    await (prisma as any).orderItem.deleteMany({ where: { order: { externalOrderReference: { startsWith: `ORD-${tag}` } } } });
    await (prisma as any).warehouseOrder.deleteMany({ where: { externalOrderReference: { startsWith: `ORD-${tag}` } } });
    await (prisma as any).product.deleteMany({ where: { externalProductCode: { startsWith: `SKU-${tag}` } } });
    await (prisma as any).receivingDiscrepancy.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: `card:${tag}` } } } });
    await (prisma as any).receivingCarton.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: `card:${tag}` } } } });
    await (prisma as any).receivingProduct.deleteMany({ where: { session: { expectedArrival: { customerArrivalCardId: `card:${tag}` } } } });
    await (prisma as any).receivingSession.deleteMany({ where: { expectedArrival: { customerArrivalCardId: `card:${tag}` } } });
    await (prisma as any).expectedArrivalItem.deleteMany({ where: { arrival: { customerArrivalCardId: `card:${tag}` } } });
    await (prisma as any).expectedArrival.deleteMany({ where: { customerArrivalCardId: `card:${tag}` } });
    await (prisma as any).categoryZoneMapping.deleteMany({ where: { category: { code: CAT } } });
    await (prisma as any).categoryMaster.deleteMany({ where: { code: CAT } });
    await (prisma as any).location.deleteMany({ where: { warehouseId } });
    await (prisma as any).level.deleteMany({ where: { rack: { aisle: { zone: { warehouseId } } } } });
    await (prisma as any).rack.deleteMany({ where: { aisle: { zone: { warehouseId } } } });
    await (prisma as any).aisle.deleteMany({ where: { zone: { warehouseId } } });
    await (prisma as any).zone.deleteMany({ where: { warehouseId } });
    await (prisma as any).warehouse.deleteMany({ where: { id: warehouseId } });
    await (prisma as any).user.deleteMany({ where: { employeeCode: `E2E-${tag}` } });
    await prisma.$disconnect();
  });

  // 1 ---------------------------------------------------------------
  it('receiving article scan creates a traceable ArticleUnit in the tote', async () => {
    const tote = await fulfillment.createContainer({ type: 'RECEIVING' }, actor);
    toteCode = tote.code;
    expect(tote.code).toMatch(/^RCN-/);

    const res = await fulfillment.scanArticleAtReceiving(
      sessionId, { sku: SKU, containerCode: toteCode }, actor,
    );
    expect(res.matched).toBe(true);
    expect(res.flash.kind).toBe('ARTICLE_RECEIVED');
    articleCode = res.flash.article.code;
    expect(articleCode).toMatch(/^ART-/);

    const unit = await (prisma as any).articleUnit.findUnique({ where: { code: articleCode }, include: { container: true } });
    expect(unit.status).toBe('IN_CONTAINER');
    expect(unit.container.code).toBe(toteCode);
    expect(unit.receivingSessionId).toBe(sessionId);
    expect(unit.categoryStatus).toBe('CONFIRMED');

    // Second unit for the completeness test later.
    const res2 = await fulfillment.scanArticleAtReceiving(
      sessionId, { sku: SKU, containerCode: toteCode }, actor,
    );
    article2Code = res2.flash.article.code;
  });

  // 2 ---------------------------------------------------------------
  it('unexpected SKU -> UNEXPECTED_ARTICLE + OPEN discrepancy visible to admin', async () => {
    const res = await fulfillment.scanArticleAtReceiving(
      sessionId, { sku: `SKU-${tag}-GHOST`, containerCode: toteCode }, actor,
    );
    expect(res.matched).toBe(false);
    expect(res.flash.kind).toBe('UNEXPECTED_ARTICLE');
    const disc = await (prisma as any).receivingDiscrepancy.findFirst({
      where: { receivingSessionId: sessionId, type: 'UNEXPECTED_PRODUCT', status: 'OPEN' },
    });
    expect(disc).toBeTruthy();
  });

  // 3 ---------------------------------------------------------------
  it('scanning into a CUSTOMER container at receiving is rejected', async () => {
    // create a temp order + bin
    await orders.intake({
      externalOrderReference: `ORD-${tag}-X`,
      externalCustomerReference: 'TEMP',
      items: [{ store: 'MAIN', externalProductCode: `SKU-${tag}-X`, productName: 'x', requestedQuantity: 1 }],
    }, 'e2e');
    const bin = await fulfillment.createContainer({ type: 'CUSTOMER', orderReference: `ORD-${tag}-X` }, actor);
    await expect(
      fulfillment.scanArticleAtReceiving(sessionId, { sku: SKU, containerCode: bin.code }, actor),
    ).rejects.toThrow(/not a receiving tote/i);
  });

  // 4 ---------------------------------------------------------------
  it('sorting scan resolves the CONFIGURED destination and suggests locations', async () => {
    const res: any = await fulfillment.sortingScanArticle(articleCode);
    expect(res.kind).toBe('DESTINATION');
    expect(res.zone.id).toBe(zoneId);
    expect(res.suggestedLocations).toContain(locationCode);
  });

  // 5 ---------------------------------------------------------------
  it('storing into the WRONG zone is rejected', async () => {
    await expect(
      fulfillment.sortingStore({ articleCode, locationCode: wrongLocationCode }, actor),
    ).rejects.toThrow(/wrong zone/i);
  });

  // 6 ---------------------------------------------------------------
  it('storing into the configured zone -> STORED with the location recorded', async () => {
    const res = await fulfillment.sortingStore({ articleCode, locationCode }, actor);
    expect(res.flash.kind).toBe('STORED');
    const unit = await (prisma as any).articleUnit.findUnique({ where: { code: articleCode }, include: { currentLocation: true } });
    expect(unit.status).toBe('STORED');
    expect(unit.currentLocation.locationCode).toBe(locationCode);
    expect(unit.containerId).toBeNull(); // out of the tote
    // store the second unit too
    await fulfillment.sortingStore({ articleCode: article2Code, locationCode }, actor);
  });

  // 7 ---------------------------------------------------------------
  it('a NEEDS_REVIEW article is blocked from storage', async () => {
    const ghost = await (prisma as any).articleUnit.findFirst({
      where: { sku: `SKU-${tag}-GHOST` },
    });
    const scan: any = await fulfillment.sortingScanArticle(ghost.code);
    expect(scan.kind).toBe('NEEDS_REVIEW');
    await expect(
      fulfillment.sortingStore({ articleCode: ghost.code, locationCode }, actor),
    ).rejects.toThrow(/NEEDS REVIEW/i);
  });

  // 8 ---------------------------------------------------------------
  it('order intake is idempotent: identical replay -> UNCHANGED', async () => {
    const payload = {
      externalOrderReference: `ORD-${tag}-A`,
      externalCustomerReference: 'AHMED',
      items: [{ store: 'MAIN', externalProductCode: SKU, productName: 'Flow Sneaker', requestedQuantity: 2 }],
    };
    const first = await orders.intake(payload as any, 'e2e');
    expect(first.outcome).toBe('CREATED');
    const replay = await orders.intake(payload as any, 'e2e');
    expect(replay.outcome).toBe('UNCHANGED');
  });

  // 9 ---------------------------------------------------------------
  it('customer bin carries the big customer label; a second active bin is rejected', async () => {
    const bin = await fulfillment.createContainer({ type: 'CUSTOMER', orderReference: `ORD-${tag}-A` }, actor);
    binCode = bin.code;
    expect(bin.code).toMatch(/^BIN-/);
    expect(bin.label).toBe('AHMED');
    await expect(
      fulfillment.createContainer({ type: 'CUSTOMER', orderReference: `ORD-${tag}-A` }, actor),
    ).rejects.toThrow(/already has bin/i);
  });

  // 10 --------------------------------------------------------------
  it('order-sorting scan answers PRODUCT -> CUSTOMER -> BIN', async () => {
    const res: any = await fulfillment.orderSortingScanArticle(articleCode);
    expect(res.kind).toBe('ASSIGNMENT');
    expect(res.order.customer).toBe('AHMED');
    expect(res.order.reference).toBe(`ORD-${tag}-A`);
    expect(res.bin.code).toBe(binCode);
  });

  // 11 --------------------------------------------------------------
  it('wrong bin and unneeded article are rejected with clear errors', async () => {
    // wrong bin: the TEMP order's bin does not need this SKU
    const wrongBin = await (prisma as any).operationalContainer.findFirst({
      where: { order: { externalOrderReference: `ORD-${tag}-X` } },
    });
    await expect(
      fulfillment.orderSortingAssign({ articleCode, containerCode: wrongBin.code }, actor),
    ).rejects.toThrow(/WRONG BIN/i);

    // unneeded article: the GHOST SKU matches no order at all
    const ghost = await (prisma as any).articleUnit.findFirst({ where: { sku: `SKU-${tag}-GHOST` } });
    const scan: any = await fulfillment.orderSortingScanArticle(ghost.code);
    expect(scan.kind).toBe('NO_ORDER');
    await expect(
      fulfillment.orderSortingAssign({ articleCode: ghost.code, containerCode: binCode }, actor),
    ).rejects.toThrow(/does not need/i);
  });

  // 12 --------------------------------------------------------------
  it('completing the order flips the bin to READY_FOR_PACKING', async () => {
    const first = await fulfillment.orderSortingAssign({ articleCode, containerCode: binCode }, actor);
    expect(first.flash.kind).toBe('ARTICLE_ASSIGNED');

    const second = await fulfillment.orderSortingAssign({ articleCode: article2Code, containerCode: binCode }, actor);
    expect(second.flash.kind).toBe('BIN_READY_FOR_PACKING');

    const bin = await (prisma as any).operationalContainer.findUnique({ where: { code: binCode } });
    expect(bin.status).toBe('READY_FOR_PACKING');
  });

  // 13 --------------------------------------------------------------
  it('packing verifies contents and creates the outbound shipment (no invented carrier)', async () => {
    // incomplete bin (TEMP order) cannot be packed
    const wrongBin = await (prisma as any).operationalContainer.findFirst({
      where: { order: { externalOrderReference: `ORD-${tag}-X` } },
    });
    await expect(fulfillment.pack(wrongBin.code, actor)).rejects.toThrow(/empty|incomplete/i);

    const view = await fulfillment.packingScanContainer(binCode);
    expect(view.order.customer).toBe('AHMED');
    expect(view.complete).toBe(true);
    expect(view.required[0]).toMatchObject({ sku: SKU, requested: 2, inBin: 2 });

    const res = await fulfillment.pack(binCode, actor);
    outCode = res.shipment.code;
    expect(outCode).toMatch(/^OUT-/);
    expect(res.shipment.status).toBe('READY_TO_SHIP');
    expect(res.shipment.carrier).toBeNull(); // isolated seam, nothing invented
    expect(res.shipment.trackingNumber).toBeNull();

    const packedBin = await (prisma as any).operationalContainer.findUnique({ where: { code: binCode } });
    expect(packedBin.status).toBe('PACKED');
    const unit = await (prisma as any).articleUnit.findUnique({ where: { code: articleCode } });
    expect(unit.status).toBe('PACKED');
  });

  // 14 --------------------------------------------------------------
  it('shipping dispatch -> SHIPPED, articles SHIPPED, bin CLOSED, history kept', async () => {
    const scan = await fulfillment.shippingScan(outCode);
    expect(scan.order.externalCustomerReference).toBe('AHMED');
    expect(scan.articles.length).toBe(2);

    const res = await fulfillment.ship(outCode, actor);
    expect(res.flash.kind).toBe('SHIPPED');

    const shipment = await (prisma as any).outboundShipment.findUnique({ where: { code: outCode } });
    expect(shipment.status).toBe('SHIPPED');
    expect(shipment.shippedAt).toBeTruthy();

    const unit = await (prisma as any).articleUnit.findUnique({ where: { code: articleCode } });
    expect(unit.status).toBe('SHIPPED');

    // cleanup closed the container but did NOT delete it (audit trail kept)
    const bin = await (prisma as any).operationalContainer.findUnique({ where: { code: binCode } });
    expect(bin).toBeTruthy();
    expect(bin.status).toBe('CLOSED');

    // double dispatch rejected
    await expect(fulfillment.ship(outCode, actor)).rejects.toThrow(/already SHIPPED/i);

    // audit chain includes the operational events
    const actions = auditRows.map((r) => r.action);
    for (const a of ['CONTAINER_CREATED', 'ARTICLE_SCANNED', 'ITEM_STORED', 'ITEM_PICKED', 'CONTAINER_READY_FOR_PACKING', 'ORDER_PACKED', 'SHIPMENT_DISPATCHED', 'CONTAINER_CLOSED']) {
      expect(actions).toContain(a);
    }
  });

  // 15 --------------------------------------------------------------
  it('outbound shipments board lists the dispatched shipment with counts', async () => {
    const rows = await fulfillment.listOutboundShipments({ q: outCode });
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe(outCode);
    expect(rows[0].status).toBe('SHIPPED');
    expect(rows[0].order.externalCustomerReference).toBe('AHMED');
    expect(rows[0]._count.articles).toBe(2);
    // status filter works and search by customer reference matches too
    const ready = await fulfillment.listOutboundShipments({ status: 'READY_TO_SHIP', q: outCode });
    expect(ready.length).toBe(0);
    const byCustomer = await fulfillment.listOutboundShipments({ q: 'AHMED' });
    expect(byCustomer.some((r) => r.code === outCode)).toBe(true);
  });

  // 16 --------------------------------------------------------------
  it('articleTrace returns the full chain up to SHIPPED', async () => {
    const t = await fulfillment.articleTrace(articleCode);
    expect(t.article.status).toBe('SHIPPED');
    expect(t.trace.crmCard).toBe(`card:${tag}`);
    expect(t.trace.receivingSession).toBeTruthy();
    expect(t.trace.customerOrder).toBe(`ORD-${tag}-A`);
    expect(t.trace.customer).toBe('AHMED');
    expect(t.trace.outboundShipment).toBe(outCode);
    expect(t.trace.shippedAt).toBeTruthy();
  });
});
