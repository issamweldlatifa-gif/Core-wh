import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';

/**
 * OPERATIONAL WAREHOUSE FLOW (Blueprint §6, §27 + Execute order).
 *
 * After a carton is opened at Receiving, every scanned piece becomes an
 * ArticleUnit and moves through QR-identified OperationalContainers:
 *
 *   RECEIVING SCAN -> RECEIVING TOTE (mixed) -> SORTING/STORAGE -> LOCATION
 *   -> ORDER SORTING (customer bin) -> PACKING (outbound shipment)
 *   -> SHIPPING -> SHIPPED -> container cleanup.
 *
 * Rules enforced here, not in the UI:
 *  - articles NEVER return to the source carton (no transition back),
 *  - sorting destination comes from CategoryZoneMapping CONFIGURATION,
 *    NEEDS_REVIEW articles are blocked from storage (manual review first),
 *  - order sorting rejects wrong bin / wrong customer / unknown article,
 *  - packing verifies bin completeness against the EXISTING WarehouseOrder,
 *  - shipping is the only transition to SHIPPED; cleanup closes containers
 *    but NEVER deletes operational history or audit rows,
 *  - the carrier integration is an isolated seam (NULL until an adapter
 *    exists — nothing invented).
 */

export interface FulfillmentActor {
  id: string;
  ip?: string | null;
}

const CONTAINER_PREFIX: Record<'RECEIVING' | 'CUSTOMER', string> = {
  RECEIVING: 'RCN-',
  CUSTOMER: 'BIN-',
};

/**
 * Carrier integration seam. NO carrier API exists in this repo today, so the
 * default adapter returns NULLs and the outbound shipment ships with an
 * internal label only. A real DHL/FedEx adapter later implements this
 * interface without touching the workflow.
 */
export interface CarrierAdapter {
  createShipment(input: { orderRef: string; customerRef: string }): Promise<{
    carrier: string | null;
    trackingNumber: string | null;
  }>;
}

export class NullCarrierAdapter implements CarrierAdapter {
  async createShipment() {
    return { carrier: null, trackingNumber: null };
  }
}

@Injectable()
export class FulfillmentService {
  private readonly carrier: CarrierAdapter = new NullCarrierAdapter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly categories: CategoriesService,
  ) {}

  // ------------------------------------------------------------------
  // code generators (same pattern as putaway PUT-xxxxxx)
  // ------------------------------------------------------------------

  private async genContainerCode(tx: Prisma.TransactionClient, type: 'RECEIVING' | 'CUSTOMER') {
    const prefix = CONTAINER_PREFIX[type];
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.operationalContainer.count({ where: { type } });
      const code = `${prefix}${String(count + 1 + i).padStart(6, '0')}`;
      if (!(await tx.operationalContainer.findUnique({ where: { code } }))) return code;
    }
    return `${prefix}R${Date.now().toString().slice(-6)}`;
  }

  private async genArticleCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.articleUnit.count();
      const code = `ART-${String(count + 1 + i).padStart(8, '0')}`;
      if (!(await tx.articleUnit.findUnique({ where: { code } }))) return code;
    }
    return `ART-R${Date.now().toString().slice(-8)}`;
  }

  private async genOutboundCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.outboundShipment.count();
      const code = `OUT-${String(count + 1 + i).padStart(6, '0')}`;
      if (!(await tx.outboundShipment.findUnique({ where: { code } }))) return code;
    }
    return `OUT-R${Date.now().toString().slice(-6)}`;
  }

  // ------------------------------------------------------------------
  // CONTAINERS — QR-identified, configuration not hardcode
  // ------------------------------------------------------------------

  async createContainer(
    input: { type: 'RECEIVING' | 'CUSTOMER'; label?: string | null; orderReference?: string | null },
    actor: FulfillmentActor,
  ) {
    let orderId: string | null = null;
    let label = input.label?.trim() || null;

    if (input.type === 'CUSTOMER') {
      const ref = input.orderReference?.trim().toUpperCase();
      if (!ref) throw new BadRequestException('A CUSTOMER bin requires the order reference.');
      const order = await this.prisma.warehouseOrder.findUnique({
        where: { externalOrderReference: ref },
      });
      if (!order) throw new NotFoundException(`Order ${ref} not found.`);
      if (order.status !== 'OPEN') throw new ConflictException(`Order ${ref} is ${order.status}.`);
      const existing = await this.prisma.operationalContainer.findFirst({
        where: { orderId: order.id, status: { in: ['ACTIVE', 'READY_FOR_PACKING'] } },
      });
      if (existing) {
        throw new ConflictException(`Order ${ref} already has bin ${existing.code}.`);
      }
      orderId = order.id;
      // Big visible label: the customer reference (BIN-001 -> AHMED).
      label = label || order.externalCustomerReference;
    }

    return this.prisma.$transaction(async (tx) => {
      const code = await this.genContainerCode(tx, input.type);
      const row = await tx.operationalContainer.create({
        data: { code, type: input.type, label, orderId, createdBy: actor.id },
        include: { order: { select: { externalOrderReference: true, externalCustomerReference: true } } },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CONTAINER_CREATED',
          entityType: 'operational_container',
          entityId: row.id,
          ipAddress: actor.ip ?? null,
          metadata: { code, type: input.type, label, order: row.order?.externalOrderReference ?? null },
        },
        tx,
      );
      return row;
    });
  }

  async listContainers(filter: { type?: string; status?: string }) {
    return this.prisma.operationalContainer.findMany({
      where: {
        ...(filter.type ? { type: filter.type as never } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        order: { select: { externalOrderReference: true, externalCustomerReference: true } },
        _count: { select: { articles: true } },
      },
    });
  }

  async containerDetail(code: string) {
    const container = await this.prisma.operationalContainer.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: {
        order: {
          include: {
            items: { include: { product: true } },
          },
        },
        articles: {
          orderBy: { updatedAt: 'desc' },
          select: {
            code: true, sku: true, productName: true, category: true, subcategory: true, status: true,
          },
        },
      },
    });
    if (!container) throw new NotFoundException('Container not found.');
    return container;
  }

  // ------------------------------------------------------------------
  // 1+2. RECEIVING ARTICLE SCAN — piece leaves the carton, enters a tote
  // ------------------------------------------------------------------

  /**
   * Scan one physical article out of an opened carton on the receiving line.
   * Creates the ArticleUnit (provenance: session + carton + expected line),
   * places it in the given RECEIVING container and updates the existing
   * per-SKU reconciliation (received quantity / UNEXPECTED discrepancy).
   * The piece NEVER returns to the carton — its container is now the tote.
   */
  async scanArticleAtReceiving(
    sessionId: string,
    input: { sku: string; containerCode: string; cartonCode?: string | null },
    actor: FulfillmentActor,
  ) {
    const sku = (input.sku || '').trim();
    if (!sku) throw new BadRequestException('SKU is required.');

    const session = await this.prisma.receivingSession.findUnique({
      where: { id: sessionId },
      include: { expectedArrival: { select: { id: true, code: true } } },
    });
    if (!session) throw new NotFoundException('Receiving session not found.');
    if (session.status !== 'RECEIVING') {
      throw new ConflictException('This receiving session is not active.');
    }

    const container = await this.prisma.operationalContainer.findUnique({
      where: { code: input.containerCode.trim().toUpperCase() },
    });
    if (!container) throw new NotFoundException('Container not found — scan a valid tote QR.');
    if (container.type !== 'RECEIVING') {
      throw new ConflictException(`${container.code} is a ${container.type} container, not a receiving tote.`);
    }
    if (container.status !== 'ACTIVE') {
      throw new ConflictException(`Container ${container.code} is ${container.status}.`);
    }

    // Optional source carton (traceability). Never blocks the scan.
    const carton = input.cartonCode
      ? await this.prisma.warehouseCarton.findFirst({
          where: {
            OR: [
              { externalCartonId: input.cartonCode.trim() },
              { qrCodeValue: input.cartonCode.trim() },
            ],
          },
        })
      : null;

    // Match against the expected reconciliation line of this session.
    const line = await this.prisma.receivingProduct.findFirst({
      where: { receivingSessionId: sessionId, sku },
    });

    return this.prisma.$transaction(async (tx) => {
      let matched = true;
      let lineId: string | null = line?.id ?? null;

      if (!line) {
        // UNEXPECTED article -> reconciliation row + OPEN discrepancy, visible
        // to the Admin exceptions view immediately. The piece is still taken
        // out of the carton (physical reality) but flagged.
        matched = false;
        const rp = await tx.receivingProduct.create({
          data: {
            receivingSessionId: sessionId, sku, expectedQuantity: 0, receivedQuantity: 1,
            difference: 1, status: 'UNEXPECTED',
          },
        });
        lineId = rp.id;
        await tx.receivingDiscrepancy.create({
          data: {
            receivingSessionId: sessionId, receivingProductId: rp.id, type: 'UNEXPECTED_PRODUCT',
            expectedQuantity: 0, actualQuantity: 1, difference: 1,
            reason: `Unexpected article ${sku} scanned at receiving`, status: 'OPEN', createdBy: actor.id,
          },
        });
      } else {
        const received = line.receivedQuantity + 1;
        const difference = received - line.expectedQuantity;
        let status: string = line.status;
        if (received >= line.expectedQuantity) status = received === line.expectedQuantity ? 'RECEIVED' : 'OVERAGE';
        else status = 'PARTIALLY_RECEIVED';
        await tx.receivingProduct.update({
          where: { id: line.id },
          data: { receivedQuantity: received, difference, status: status as never },
        });
        if (status === 'OVERAGE' && line.status !== 'OVERAGE') {
          await tx.receivingDiscrepancy.create({
            data: {
              receivingSessionId: sessionId, receivingProductId: line.id, type: 'OVERAGE',
              expectedQuantity: line.expectedQuantity, actualQuantity: received, difference,
              reason: `Overage on ${sku} (+${difference})`, status: 'OPEN', createdBy: actor.id,
            },
          });
        }
      }

      // Classification rides from the expected line (validated at intake).
      const arrivalItem = line?.arrivalItemId
        ? await tx.expectedArrivalItem.findUnique({ where: { id: line.arrivalItemId } })
        : null;

      const code = await this.genArticleCode(tx);
      const article = await tx.articleUnit.create({
        data: {
          code,
          sku,
          productName: line?.productName ?? null,
          category: line?.category ?? null,
          subcategory: line?.subcategory ?? null,
          categoryStatus: (line?.categoryStatus ?? 'NEEDS_REVIEW') as never,
          status: 'IN_CONTAINER',
          arrivalItemId: arrivalItem?.id ?? line?.arrivalItemId ?? null,
          receivingSessionId: sessionId,
          sourceCartonId: carton?.id ?? null,
          containerId: container.id,
        },
      });

      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'ARTICLE_SCANNED' as never,
          entityType: 'article_unit',
          entityId: article.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            article: code, sku, matched,
            session: session.code,
            carton: carton?.externalCartonId ?? input.cartonCode ?? null,
            container: container.code,
            category: article.category, subcategory: article.subcategory,
            categoryStatus: article.categoryStatus,
          },
        },
        tx,
      );

      return {
        flash: {
          kind: matched ? 'ARTICLE_RECEIVED' : 'UNEXPECTED_ARTICLE',
          article: {
            code: article.code, sku, productName: article.productName,
            category: article.category, subcategory: article.subcategory,
            categoryStatus: article.categoryStatus,
          },
          container: container.code,
        },
        matched,
        receivingProductId: lineId,
      };
    });
  }

  // ------------------------------------------------------------------
  // 3. SORTING + STORAGE — article -> configured destination -> location
  // ------------------------------------------------------------------

  /** Scan an article: the SYSTEM decides where it goes. */
  async sortingScanArticle(articleCode: string) {
    const article = await this.getArticle(articleCode);

    if (!['IN_CONTAINER', 'RECEIVED'].includes(article.status)) {
      return {
        kind: 'REJECTED' as const,
        reason: `Article is ${article.status} — it is not waiting for storage.`,
        article: this.publicArticle(article),
      };
    }

    if (article.categoryStatus !== 'CONFIRMED' || !article.category) {
      // Blueprint §8/§9: NEEDS_REVIEW is an operational state — never guess.
      return {
        kind: 'NEEDS_REVIEW' as const,
        action: 'MANUAL REVIEW REQUIRED',
        article: this.publicArticle(article),
      };
    }

    const destination = await this.categories.resolveDestination([article.category]);
    if (destination.kind !== 'DESTINATION') {
      return { kind: destination.kind, article: this.publicArticle(article), detail: destination };
    }

    // Offer concrete free STORAGE locations inside the configured zone so the
    // worker sees the warehouse tree target, not just a zone name.
    const locations = await this.prisma.location.findMany({
      where: { zoneId: destination.zone.id, status: 'ACTIVE', locationType: 'STORAGE' },
      orderBy: { locationCode: 'asc' },
      take: 5,
      select: { locationCode: true },
    });

    return {
      kind: 'DESTINATION' as const,
      article: this.publicArticle(article),
      zone: destination.zone,
      suggestedLocations: locations.map((l) => l.locationCode),
    };
  }

  /** Scan the location: validate against the configured destination, store. */
  async sortingStore(
    input: { articleCode: string; locationCode: string },
    actor: FulfillmentActor,
  ) {
    const article = await this.getArticle(input.articleCode);
    if (!['IN_CONTAINER', 'RECEIVED'].includes(article.status)) {
      throw new ConflictException(`Article is ${article.status} — cannot store.`);
    }
    if (article.categoryStatus !== 'CONFIRMED' || !article.category) {
      throw new ConflictException('CATEGORY: NEEDS REVIEW — MANUAL REVIEW REQUIRED before storage.');
    }

    const location = await this.prisma.location.findFirst({
      where: {
        OR: [
          { locationCode: input.locationCode.trim() },
          { barcodeValue: input.locationCode.trim() },
          { qrValue: input.locationCode.trim() },
        ],
      },
      include: { zone: { select: { id: true, code: true } } },
    });
    if (!location) throw new NotFoundException('Location not found.');
    if (location.status !== 'ACTIVE') {
      throw new ConflictException(`Location ${location.locationCode} is ${location.status}.`);
    }

    // The destination is CONFIGURATION: a resolved zone is binding. A scan
    // into another zone is rejected — never a silent wrong destination.
    const destination = await this.categories.resolveDestination([article.category]);
    if (destination.kind === 'DESTINATION' && destination.zone.id !== location.zone.id) {
      throw new ConflictException(
        `Wrong zone: ${article.category} is configured for zone ${destination.zone.code}, scanned ${location.zone.code}.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.articleUnit.update({
        where: { id: article.id },
        data: {
          status: 'STORED',
          currentLocationId: location.id,
          storedAt: new Date(),
          containerId: null, // out of the tote, onto the shelf
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'ITEM_STORED',
          entityType: 'article_unit',
          entityId: article.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            article: article.code, sku: article.sku,
            category: article.category, subcategory: article.subcategory,
            location: location.locationCode, zone: location.zone.code,
            configured_destination: destination.kind === 'DESTINATION' ? destination.zone.code : null,
            resolution: destination.kind,
          },
        },
        tx,
      );
      return {
        flash: { kind: 'STORED', article: article.code, location: location.locationCode },
        article: this.publicArticle(updated as never),
      };
    });
  }

  // ------------------------------------------------------------------
  // 4. CUSTOMER ORDER SORTING — article -> customer -> bin
  // ------------------------------------------------------------------

  /**
   * Scan an article: the SYSTEM finds which EXISTING open order needs this
   * SKU and which customer bin it belongs to. Nothing is created here —
   * orders come from the existing Orders projection.
   */
  async orderSortingScanArticle(articleCode: string) {
    const article = await this.getArticle(articleCode);

    if (article.status === 'IN_CUSTOMER_BIN' || article.status === 'PACKED' || article.status === 'SHIPPED') {
      return {
        kind: 'REJECTED' as const,
        reason: `Article is already ${article.status}.`,
        article: this.publicArticle(article),
      };
    }

    const match = await this.findOrderNeeding(article.sku);
    if (!match) {
      return {
        kind: 'NO_ORDER' as const,
        reason: `No open order needs SKU ${article.sku}.`,
        article: this.publicArticle(article),
      };
    }

    const bin = await this.prisma.operationalContainer.findFirst({
      where: { orderId: match.order.id, type: 'CUSTOMER', status: 'ACTIVE' },
    });

    return {
      kind: 'ASSIGNMENT' as const,
      article: this.publicArticle(article),
      order: {
        reference: match.order.externalOrderReference,
        customer: match.order.externalCustomerReference,
      },
      orderItemId: match.orderItem.id,
      bin: bin ? { code: bin.code, label: bin.label } : null,
      binMissing: !bin,
    };
  }

  /**
   * Scan the bin: hard validation — the bin must be the one belonging to the
   * matched order. Wrong bin / wrong customer -> operation refused.
   */
  async orderSortingAssign(
    input: { articleCode: string; containerCode: string },
    actor: FulfillmentActor,
  ) {
    const article = await this.getArticle(input.articleCode);
    if (['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'].includes(article.status)) {
      throw new ConflictException(`Article is already ${article.status}.`);
    }

    const bin = await this.prisma.operationalContainer.findUnique({
      where: { code: input.containerCode.trim().toUpperCase() },
      include: { order: { include: { items: { include: { product: true } } } } },
    });
    if (!bin) throw new NotFoundException('Container not found.');
    if (bin.type !== 'CUSTOMER') throw new ConflictException(`${bin.code} is not a customer bin.`);
    if (bin.status !== 'ACTIVE') throw new ConflictException(`Bin ${bin.code} is ${bin.status}.`);
    if (!bin.order) throw new ConflictException(`Bin ${bin.code} has no order attached.`);

    // The article must actually be needed by THIS bin's order.
    const match = await this.findOrderNeeding(article.sku, bin.order.id);
    if (!match) {
      throw new ConflictException(
        `WRONG BIN: order ${bin.order.externalOrderReference} (${bin.order.externalCustomerReference}) does not need SKU ${article.sku}.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.articleUnit.update({
        where: { id: article.id },
        data: {
          status: 'IN_CUSTOMER_BIN',
          containerId: bin.id,
          currentLocationId: null, // picked off the shelf into the bin
          orderId: bin.order!.id,
          orderItemId: match.orderItem.id,
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'ITEM_PICKED',
          entityType: 'article_unit',
          entityId: article.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            article: article.code, sku: article.sku,
            order: bin.order!.externalOrderReference,
            customer: bin.order!.externalCustomerReference,
            bin: bin.code,
          },
        },
        tx,
      );

      // Completeness check: every OPEN line fully covered -> bin is ready.
      const readiness = await this.checkOrderCompleteness(tx, bin.order!.id);
      if (readiness.complete) {
        await tx.operationalContainer.update({
          where: { id: bin.id },
          data: { status: 'READY_FOR_PACKING' },
        });
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'CONTAINER_READY_FOR_PACKING' as never,
            entityType: 'operational_container',
            entityId: bin.id,
            ipAddress: actor.ip ?? null,
            metadata: { bin: bin.code, order: bin.order!.externalOrderReference },
          },
          tx,
        );
      }

      return {
        flash: {
          kind: readiness.complete ? 'BIN_READY_FOR_PACKING' : 'ARTICLE_ASSIGNED',
          article: article.code,
          bin: bin.code,
          customer: bin.order!.externalCustomerReference,
          progress: readiness,
        },
      };
    });
  }

  // ------------------------------------------------------------------
  // 5. PACKING — bin -> verification -> outbound shipment
  // ------------------------------------------------------------------

  /** Scan the bin QR: shows customer + order + required vs present items. */
  async packingScanContainer(containerCode: string) {
    const bin = await this.containerDetail(containerCode);
    if (bin.type !== 'CUSTOMER') throw new ConflictException(`${bin.code} is not a customer bin.`);
    if (!bin.order) throw new ConflictException(`Bin ${bin.code} has no order attached.`);

    const required = bin.order.items
      .filter((it) => it.status === 'OPEN')
      .map((it) => ({
        sku: it.product.externalProductCode,
        productName: it.product.name,
        requested: it.requestedQuantity,
        inBin: bin.articles.filter(
          (a) => a.sku === it.product.externalProductCode && a.status === 'IN_CUSTOMER_BIN',
        ).length,
      }));
    const complete = required.every((r) => r.inBin >= r.requested);

    return {
      bin: { code: bin.code, label: bin.label, status: bin.status },
      order: {
        reference: bin.order.externalOrderReference,
        customer: bin.order.externalCustomerReference,
      },
      required,
      articles: bin.articles.filter((a) => a.status === 'IN_CUSTOMER_BIN'),
      complete,
    };
  }

  /** Verified -> pack: creates the outbound shipment with an internal label. */
  async pack(containerCode: string, actor: FulfillmentActor) {
    const bin = await this.prisma.operationalContainer.findUnique({
      where: { code: containerCode.trim().toUpperCase() },
      include: {
        order: { include: { items: { include: { product: true } } } },
        articles: { where: { status: 'IN_CUSTOMER_BIN' } },
      },
    });
    if (!bin) throw new NotFoundException('Container not found.');
    if (bin.type !== 'CUSTOMER' || !bin.order) throw new ConflictException('Not a customer bin.');
    if (bin.status === 'PACKED' || bin.status === 'CLOSED') {
      throw new ConflictException(`Bin ${bin.code} is already ${bin.status}.`);
    }
    if (bin.articles.length === 0) throw new ConflictException('Bin is empty.');

    // Completeness gate: an incomplete order cannot be packed silently.
    const readiness = await this.checkOrderCompleteness(this.prisma, bin.order.id);
    if (!readiness.complete) {
      throw new ConflictException(
        `Order incomplete: ${readiness.missing.map((m) => `${m.sku} ${m.have}/${m.need}`).join(', ')}.`,
      );
    }

    // Carrier seam — returns NULLs until a real adapter is configured.
    const carrierResult = await this.carrier.createShipment({
      orderRef: bin.order.externalOrderReference,
      customerRef: bin.order.externalCustomerReference,
    });

    return this.prisma.$transaction(async (tx) => {
      const code = await this.genOutboundCode(tx);
      const shipment = await tx.outboundShipment.create({
        data: {
          code,
          orderId: bin.order!.id,
          containerId: bin.id,
          status: 'READY_TO_SHIP',
          carrier: carrierResult.carrier,
          trackingNumber: carrierResult.trackingNumber,
          packedBy: actor.id,
        },
      });
      await tx.articleUnit.updateMany({
        where: { containerId: bin.id, status: 'IN_CUSTOMER_BIN' },
        data: { status: 'PACKED', outboundShipmentId: shipment.id },
      });
      await tx.operationalContainer.update({ where: { id: bin.id }, data: { status: 'PACKED' } });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'ORDER_PACKED',
          entityType: 'outbound_shipment',
          entityId: shipment.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            shipment: code,
            order: bin.order!.externalOrderReference,
            customer: bin.order!.externalCustomerReference,
            bin: bin.code,
            articles: bin.articles.map((a) => a.code),
            carrier: carrierResult.carrier,
            tracking: carrierResult.trackingNumber,
          },
        },
        tx,
      );
      return {
        flash: { kind: 'PACKED', shipment: code, order: bin.order!.externalOrderReference },
        shipment: {
          code,
          status: 'READY_TO_SHIP',
          carrier: carrierResult.carrier,
          trackingNumber: carrierResult.trackingNumber,
          labelValue: code, // internal label/QR — printed at the bench
        },
      };
    });
  }

  // ------------------------------------------------------------------
  // 6+7. SHIPPING + CLEANUP
  // ------------------------------------------------------------------

  async shippingScan(code: string) {
    const shipment = await this.prisma.outboundShipment.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: {
        order: { select: { externalOrderReference: true, externalCustomerReference: true } },
        articles: { select: { code: true, sku: true, productName: true, status: true } },
        container: { select: { code: true } },
      },
    });
    if (!shipment) throw new NotFoundException('Outbound shipment not found.');
    return shipment;
  }

  /** Dispatch: SHIPPED + container cleanup. History and audit are kept. */
  async ship(code: string, actor: FulfillmentActor) {
    const shipment = await this.prisma.outboundShipment.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: { order: true, container: true },
    });
    if (!shipment) throw new NotFoundException('Outbound shipment not found.');
    if (shipment.status === 'SHIPPED') {
      throw new ConflictException(`Shipment ${shipment.code} is already SHIPPED.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.outboundShipment.update({
        where: { id: shipment.id },
        data: { status: 'SHIPPED', shippedBy: actor.id, shippedAt: new Date() },
      });
      await tx.articleUnit.updateMany({
        where: { outboundShipmentId: shipment.id },
        data: { status: 'SHIPPED', containerId: null },
      });
      // Cleanup = release the operational container for reuse-accounting.
      // The container row itself is KEPT (audit trail), only its state moves.
      if (shipment.containerId) {
        await tx.operationalContainer.update({
          where: { id: shipment.containerId },
          data: { status: 'CLOSED' },
        });
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'CONTAINER_CLOSED' as never,
            entityType: 'operational_container',
            entityId: shipment.containerId,
            ipAddress: actor.ip ?? null,
            metadata: { bin: shipment.container?.code, reason: 'order shipped' },
          },
          tx,
        );
      }
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'SHIPMENT_DISPATCHED',
          entityType: 'outbound_shipment',
          entityId: shipment.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            shipment: shipment.code,
            order: shipment.order.externalOrderReference,
            customer: shipment.order.externalCustomerReference,
            carrier: shipment.carrier,
            tracking: shipment.trackingNumber,
          },
        },
        tx,
      );
      return { flash: { kind: 'SHIPPED', shipment: shipment.code } };
    });
  }

  // ------------------------------------------------------------------
  // TRACEABILITY — full chain for one article
  // ------------------------------------------------------------------

  async articleTrace(code: string) {
    const article = await this.prisma.articleUnit.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: {
        arrivalItem: {
          include: { arrival: { select: { code: true, customerArrivalCardId: true, customerName: true } } },
        },
        receivingSession: { select: { code: true } },
        sourceCarton: {
          select: { externalCartonId: true, shipment: { select: { code: true, externalShipmentId: true } } },
        },
        container: { select: { code: true, type: true, label: true, status: true } },
        currentLocation: { select: { locationCode: true, zone: { select: { code: true } } } },
        order: { select: { externalOrderReference: true, externalCustomerReference: true } },
        outboundShipment: {
          select: { code: true, status: true, carrier: true, trackingNumber: true, shippedAt: true },
        },
      },
    });
    if (!article) throw new NotFoundException('Article not found.');
    return {
      article: this.publicArticle(article as never),
      trace: {
        crmCard: article.arrivalItem?.arrival?.customerArrivalCardId ?? null,
        expectedArrival: article.arrivalItem?.arrival?.code ?? null,
        inboundShipment: article.sourceCarton?.shipment?.externalShipmentId ?? null,
        sourceCarton: article.sourceCarton?.externalCartonId ?? null,
        receivingSession: article.receivingSession?.code ?? null,
        container: article.container
          ? { code: article.container.code, type: article.container.type, label: article.container.label }
          : null,
        storageLocation: article.currentLocation
          ? { code: article.currentLocation.locationCode, zone: article.currentLocation.zone.code }
          : null,
        customerOrder: article.order?.externalOrderReference ?? null,
        customer: article.order?.externalCustomerReference ?? null,
        outboundShipment: article.outboundShipment?.code ?? null,
        tracking: article.outboundShipment?.trackingNumber ?? null,
        shippedAt: article.outboundShipment?.shippedAt ?? null,
      },
    };
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  private async getArticle(code: string) {
    const article = await this.prisma.articleUnit.findUnique({
      where: { code: (code || '').trim().toUpperCase() },
    });
    if (!article) throw new NotFoundException('Article not found — scan a valid ART code.');
    return article;
  }

  private publicArticle(a: {
    code: string; sku: string; productName: string | null; category: string | null;
    subcategory: string | null; categoryStatus: string; status: string;
  }) {
    return {
      code: a.code, sku: a.sku, productName: a.productName,
      category: a.category, subcategory: a.subcategory,
      categoryStatus: a.categoryStatus, status: a.status,
    };
  }

  /**
   * Find an OPEN order (optionally a specific one) that still needs the SKU:
   * assigned articles (IN_CUSTOMER_BIN/PACKED/SHIPPED) < requestedQuantity.
   * Orders that already have a customer bin win the tie (finish what's begun).
   */
  private async findOrderNeeding(sku: string, orderId?: string) {
    const items = await this.prisma.orderItem.findMany({
      where: {
        status: 'OPEN',
        order: { status: 'OPEN', ...(orderId ? { id: orderId } : {}) },
        product: { externalProductCode: sku.trim().toUpperCase() },
      },
      include: {
        order: { include: { containers: { where: { type: 'CUSTOMER', status: 'ACTIVE' } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const item of items.sort(
      (a, b) => (b.order.containers.length ? 1 : 0) - (a.order.containers.length ? 1 : 0),
    )) {
      const assigned = await this.prisma.articleUnit.count({
        where: { orderItemId: item.id, status: { in: ['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'] } },
      });
      if (assigned < item.requestedQuantity) {
        return { order: item.order, orderItem: item };
      }
    }
    return null;
  }

  /** Are all OPEN lines of the order fully covered by binned articles? */
  private async checkOrderCompleteness(
    db: Prisma.TransactionClient | PrismaService,
    orderId: string,
  ) {
    const items = await (db as Prisma.TransactionClient).orderItem.findMany({
      where: { orderId, status: 'OPEN' },
      include: { product: { select: { externalProductCode: true } } },
    });
    const missing: Array<{ sku: string; need: number; have: number }> = [];
    for (const item of items) {
      const have = await (db as Prisma.TransactionClient).articleUnit.count({
        where: { orderItemId: item.id, status: { in: ['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'] } },
      });
      if (have < item.requestedQuantity) {
        missing.push({ sku: item.product.externalProductCode, need: item.requestedQuantity, have });
      }
    }
    return { complete: missing.length === 0, missing };
  }
}
