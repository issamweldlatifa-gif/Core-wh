import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from '../categories/categories.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { TaskDispatchService } from '../assignments/dispatch.service';
import { WorkflowService } from '../workflow/workflow.service';
import { OPERATIONAL_ERRORS, normalizeScan } from '../../common/scan-normalizer';

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
    private readonly events: EventEmitter2,
    private readonly assignments: AssignmentsService,
    private readonly dispatch: TaskDispatchService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * WORKFLOW SEPARATION — guard on miss. Called only when a product /
   * container / shipment lookup MISSED: a carton identifier scanned at a
   * product-only station is rejected explicitly (409, audited guard row)
   * because its flow ended at the verification report; any other code
   * passes through silently so the caller's own not-found path runs.
   */
  private async rejectIfCartonAtProductStation(
    rawCode: string,
    station: string,
    actor?: { id?: string | null; ip?: string | null },
  ): Promise<void> {
    await this.workflow.assertNotCartonIdentifier(rawCode, station, actor);
  }

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
    input: { type: 'RECEIVING' | 'CUSTOMER'; label?: string | null; orderReference?: string | null; capacity?: number | null },
    actor: FulfillmentActor,
  ) {
    let orderId: string | null = null;
    let label = input.label?.trim() || null;
    const capacity = input.capacity ?? 50;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
      throw new BadRequestException('capacity must be an integer between 1 and 100000.');
    }

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
        data: { code, type: input.type, label, orderId, capacity, createdBy: actor.id },
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
    input: { sku: string; containerCode: string; cartonCode?: string | null; operationId?: string },
    actor: FulfillmentActor,
  ) {
    // Single normalization boundary (Master Order §24): CT40 and Phone may
    // deliver the same code with different case/whitespace/line terminators.
    const sku = normalizeScan(input.sku);
    if (!sku) throw new BadRequestException('SKU is required.');

    const session = await this.prisma.receivingSession.findUnique({
      where: { id: sessionId },
      include: { expectedArrival: { select: { id: true, code: true } } },
    });
    if (!session) throw new NotFoundException('Receiving session not found.');
    await this.assignments.assertOperationalAccess(actor.id, 'receiving', { arrivalId: session.arrivalId });
    if (session.status !== 'RECEIVING') {
      throw new ConflictException('This receiving session is not active.');
    }

    // C-4 idempotency: the same client operationId is applied exactly once.
    // A replay answers with a DUPLICATE flash — never a second ArticleUnit.
    if (input.operationId) {
      const dup = await this.prisma.receivingScanEvent.findUnique({ where: { operationId: input.operationId } });
      if (dup) {
        if (dup.sessionId !== sessionId) throw new ConflictException('This operation was already applied to another session.');
        return { flash: { kind: 'DUPLICATE_OPERATION', operationId: input.operationId }, matched: true, replay: true, receivingProductId: null };
      }
    }

    const containerCode = normalizeScan(input.containerCode).toUpperCase();
    const container = await this.prisma.operationalContainer.findUnique({
      where: { code: containerCode },
    });
    if (!container) throw new NotFoundException(OPERATIONAL_ERRORS.containerNotFound);
    if (container.type !== 'RECEIVING') {
      throw new ConflictException(OPERATIONAL_ERRORS.containerWrongType);
    }
    if (container.status !== 'ACTIVE') {
      throw new ConflictException(OPERATIONAL_ERRORS.containerClosed);
    }

    // Optional source carton (traceability). Never blocks the scan.
    const cartonCode = normalizeScan(input.cartonCode);
    const carton = cartonCode
      ? await this.prisma.warehouseCarton.findFirst({
          where: {
            OR: [
              { externalCartonId: { equals: cartonCode, mode: 'insensitive' } },
              { qrCodeValue: { equals: cartonCode, mode: 'insensitive' } },
              { barcodeValue: { equals: cartonCode, mode: 'insensitive' } },
            ],
          },
        })
      : null;

    // Match against the expected reconciliation line of this session.
    // Case-insensitive at the backend boundary (Order §24) — the stored
    // line value is authoritative, the scan only looks it up.
    const line = await this.prisma.receivingProduct.findFirst({
      where: { receivingSessionId: sessionId, sku: { equals: sku, mode: 'insensitive' } },
    });
    if (!line) {
      // No product line: a carton identifier scanned as a product is rejected
      // explicitly (its flow ended at the verification report); anything else
      // continues down the UNEXPECTED path below.
      await this.rejectIfCartonAtProductStation(sku, 'RECEIVING', actor);
    }

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

      if (input.operationId) {
        await tx.receivingScanEvent.create({ data: {
          sessionId, operationId: input.operationId, kind: 'ARTICLE', code: sku, quantity: 1,
        } });
      }

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

      // Container counter n/capacity (§20–21). At capacity the tote
      // auto-closes: it no longer accepts articles and is visibly ready for
      // the sorting step. Manual CLOSE (no minimum) is a separate endpoint.
      const inContainer = await tx.articleUnit.count({
        where: { containerId: container.id, status: 'IN_CONTAINER' },
      });
      const capacity = container.capacity ?? 50;
      const containerFull = inContainer >= capacity;
      if (containerFull) {
        await tx.operationalContainer.update({
          where: { id: container.id },
          data: { status: 'READY_FOR_SORTING' },
        });
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'CONTAINER_CLOSED' as never,
            entityType: 'operational_container',
            entityId: container.id,
            ipAddress: actor.ip ?? null,
            metadata: { container: container.code, reason: 'capacity reached', count: inContainer, capacity },
          },
          tx,
        );
        this.events.emit('container.full', { container: container.code, count: inContainer, t: Date.now() });
      }

      return {
        flash: {
          kind: matched ? 'ARTICLE_RECEIVED' : 'UNEXPECTED_ARTICLE',
          article: {
            code: article.code, sku, productName: article.productName,
            category: article.category, subcategory: article.subcategory,
            categoryStatus: article.categoryStatus,
          },
          container: container.code,
          containerCount: inContainer,
          containerCapacity: capacity,
          containerFull,
        },
        matched,
        receivingProductId: lineId,
      };
    }).then(async (result) => {
      // Master Order §12/§13: when a unit that an open order still needs is
      // received, the customer-sorting work becomes dispatchable. Deferred
      // order cards (goods arrived after the order) are picked up here.
      // Replays (replay:true) returned before this point and never re-fire.
      await this.dispatch.onArticleReceived(sku, actor.id, {
        reason: `article SKU ${sku} received at receiving`,
      });
      return result;
    });
  }

  /**
   * Manual container CLOSE (§21): a receiving tote can be closed at ANY
   * count — there is no mandatory minimum. Closed = READY_FOR_SORTING: the
   * tote stops accepting articles and moves to the sorting step.
   */
  async closeContainer(containerCode: string, actor: FulfillmentActor) {
    const container = await this.prisma.operationalContainer.findUnique({
      where: { code: normalizeScan(containerCode).toUpperCase() },
      include: { _count: { select: { articles: { where: { status: 'IN_CONTAINER' } } } } },
    });
    if (!container) {
      await this.rejectIfCartonAtProductStation(containerCode, 'RECEIVING', actor);
      throw new NotFoundException(OPERATIONAL_ERRORS.containerNotFound);
    }
    if (container.type !== 'RECEIVING') {
      throw new ConflictException(`${container.code} is a ${container.type} container — only receiving totes close here.`);
    }
    if (container.status !== 'ACTIVE') {
      throw new ConflictException(OPERATIONAL_ERRORS.containerClosed);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.operationalContainer.update({
        where: { id: container.id },
        data: { status: 'READY_FOR_SORTING' },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CONTAINER_CLOSED' as never,
          entityType: 'operational_container',
          entityId: container.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            container: container.code,
            reason: 'closed manually',
            count: container._count.articles,
            capacity: container.capacity,
          },
        },
        tx,
      );
    });
    this.events.emit('container.closed', { container: container.code, t: Date.now() });
    return { ok: true, code: container.code, status: 'READY_FOR_SORTING' as const, count: container._count.articles };
  }

  // ------------------------------------------------------------------
  // 2b. CONTAINER STAGING — a CLOSED tote is moved to a configured
  //     temporary storage station (Master Order §11). The station → zone
  //     relationship is BACKEND/ADMIN configuration (Station.zoneId), not
  //     code. This records the physical resting place of a full container
  //     until the sorting step, and hands the work to the next worker via
  //     the automatic dispatch (the receiving-container task completes, a
  //     sorting task is created for the staged container).
  // ------------------------------------------------------------------

  /**
   * Move a closed (READY_FOR_SORTING) receiving container to a temporary
   * storage station. The station must be ACTIVE with department STAGING and
   * a configured zone. If `stationCode` is omitted the worker's own assigned
   * ACTIVE STAGING station is used (never trusted from the client otherwise).
   */
  async stageContainer(
    containerCode: string,
    actor: FulfillmentActor & { stationId?: string | null },
    opts: { stationCode?: string | null } = {},
  ) {
    const container = await this.prisma.operationalContainer.findUnique({
      where: { code: containerCode.trim().toUpperCase() },
      include: { _count: { select: { articles: { where: { status: 'IN_CONTAINER' } } } } },
    });
    if (!container) {
      await this.rejectIfCartonAtProductStation(containerCode, 'STAGING', actor);
      throw new NotFoundException(OPERATIONAL_ERRORS.containerNotFound);
    }
    if (container.type !== 'RECEIVING') {
      throw new ConflictException(`${container.code} is a ${container.type} container — only receiving totes are staged here.`);
    }
    if (container.status !== 'READY_FOR_SORTING') {
      throw new ConflictException(
        container.status === 'ACTIVE'
          ? `Container ${container.code} is still open. Close it before staging.`
          : `Container ${container.code} is ${container.status}.`,
      );
    }
    if (container.stagingStationId) {
      throw new ConflictException(`Container ${container.code} is already staged.`);
    }

    // Resolve the target STAGING station SERVER-SIDE only — the client never
    // decides the storage location. Priority: explicit valid stationCode,
    // then the worker's own ACTIVE station.
    let station;
    const requestedCode = normalizeScan(opts.stationCode).toUpperCase();
    if (requestedCode) {
      station = await this.prisma.station.findUnique({
        where: { code: requestedCode },
        include: { zone: { select: { id: true, code: true, warehouseId: true } } },
      });
      if (!station) throw new NotFoundException(`Staging station "${opts.stationCode}" not found.`);
    } else if (actor.stationId) {
      station = await this.prisma.station.findUnique({
        where: { id: actor.stationId },
        include: { zone: { select: { id: true, code: true, warehouseId: true } } },
      });
    } else {
      // The worker's own ACTIVE station (Station.assignedWorkerId soft link).
      station = await this.prisma.station.findFirst({
        where: { assignedWorkerId: actor.id, status: 'ACTIVE' },
        orderBy: { code: 'asc' },
        include: { zone: { select: { id: true, code: true, warehouseId: true } } },
      });
    }

    if (!station || station.department !== 'STAGING') {
      throw new ConflictException(
        'No STAGING station is available for this worker. A supervisor must configure a temporary storage station.',
      );
    }
    if (station.status !== 'ACTIVE') {
      throw new ConflictException(`Staging station ${station.code} is ${station.status}.`);
    }
    if (!station.zoneId) {
      throw new ConflictException(`Staging station ${station.code} has no zone configured. Assign its zone in Admin.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.operationalContainer.findUnique({ where: { id: container.id } });
      if (!current || current.status !== 'READY_FOR_SORTING' || current.stagingStationId) {
        throw new ConflictException('Container already changed or staged.');
      }
      const staged = await tx.operationalContainer.update({
        where: { id: container.id },
        data: { stagingStationId: station.id, stagedAt: new Date(), stagedById: actor.id },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CONTAINER_STAGED' as never,
          entityType: 'operational_container',
          entityId: container.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            container: container.code,
            station: station.code,
            stationName: station.name,
            zone: station.zone?.code ?? null,
            count: container._count.articles,
            capacity: container.capacity,
          },
        },
        tx,
      );
      // Hand the work to the next worker: the container/placement task is
      // done, a sorting task is auto-created for the staged container.
      await this.dispatch.onContainerStaged(
        { id: staged.id, code: staged.code },
        actor.id,
        { db: tx, reason: `container ${container.code} staged at ${station.code}` },
      );
      return {
        ok: true,
        code: container.code,
        status: 'READY_FOR_SORTING' as const,
        count: container._count.articles,
        station: { code: station.code, name: station.name, department: station.department },
        zone: station.zone ? { code: station.zone.code } : null,
        stagedAt: staged.stagedAt,
      };
    });
  }

  // ------------------------------------------------------------------
  // 3. SORTING + STORAGE — article -> configured destination -> location
  // ------------------------------------------------------------------

  /** Scan an article: the SYSTEM decides where it goes. */
  async sortingScanArticle(articleCode: string) {
    // Guard on miss: a carton identifier is rejected explicitly (409) —
    // its flow ended at the verification report; anything else behaves
    // exactly as before (read-only scan: null-actor audit).
    const article = await this.getProductArticleOrRejectCarton(articleCode, 'SORTING');

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
    const article = await this.getProductArticleOrRejectCarton(input.articleCode, 'SORTING', actor);
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
    // Guard on miss (read-only scan: null-actor audit).
    const article = await this.getProductArticleOrRejectCarton(articleCode, 'ORDER_SORTING');

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
    const article = await this.getProductArticleOrRejectCarton(input.articleCode, 'ORDER_SORTING', actor);
    if (['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'].includes(article.status)) {
      throw new ConflictException(OPERATIONAL_ERRORS.articleNotReady);
    }

    const bin = await this.prisma.operationalContainer.findUnique({
      where: { code: normalizeScan(input.containerCode).toUpperCase() },
      include: { order: { include: { items: { include: { product: true } } } } },
    });
    if (!bin) throw new NotFoundException(OPERATIONAL_ERRORS.containerNotFound);
    if (bin.type !== 'CUSTOMER') throw new ConflictException(OPERATIONAL_ERRORS.containerWrongType);
    if (bin.status !== 'ACTIVE') {
      throw new ConflictException(
        bin.status === 'READY_FOR_PACKING'
          ? `${OPERATIONAL_ERRORS.binClosed} (${bin.code} is complete — use the packing step).`
          : `Bin ${bin.code} is ${bin.status}.`,
      );
    }
    if (!bin.order) throw new ConflictException(`Bin ${bin.code} has no order attached.`);

    // The article must actually be needed by THIS bin's order.
    const match = await this.findOrderNeeding(article.sku, bin.order.id);
    if (!match) {
      throw new ConflictException(
        `${OPERATIONAL_ERRORS.binWrongCustomer} Order ${bin.order.externalOrderReference} (${bin.order.externalCustomerReference}) does not need SKU ${article.sku}.`,
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
      let binCompletedNow = false;
      if (readiness.complete && bin.status === 'ACTIVE') {
        // Master Order §15: completion generates the customer/container QR
        // and LOCKS the card. The worker can no longer add articles (status
        // gate above); any reopen is an authorized, audited ADMIN correction
        // (REOPEN_CUSTOMER_BIN) only.
        const qrValue = `AYROVI:${bin.code}:${bin.order!.externalOrderReference}:${bin.order!.externalCustomerReference}`;
        await tx.operationalContainer.update({
          where: { id: bin.id },
          data: { status: 'READY_FOR_PACKING', qrValue: bin.qrValue ?? qrValue },
        });
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'CUSTOMER_QR_GENERATED' as never,
            entityType: 'operational_container',
            entityId: bin.id,
            ipAddress: actor.ip ?? null,
            metadata: { bin: bin.code, order: bin.order!.externalOrderReference, customer: bin.order!.externalCustomerReference, qrValue },
          },
          tx,
        );
        await this.audit.log(
          {
            actorUserId: actor.id,
            action: 'CUSTOMER_CONTAINER_LOCKED' as never,
            entityType: 'operational_container',
            entityId: bin.id,
            ipAddress: actor.ip ?? null,
            metadata: { bin: bin.code, order: bin.order!.externalOrderReference },
          },
          tx,
        );
        binCompletedNow = true;
      }
      if (readiness.complete) {
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

      this.events.emit(readiness.complete ? 'bin.ready' : 'scan.accepted', {
        article: article.code, bin: bin.code, t: Date.now(),
      });
      return {
        flash: {
          kind: readiness.complete ? 'BIN_READY_FOR_PACKING' : 'ARTICLE_ASSIGNED',
          article: article.code,
          bin: bin.code,
          customer: bin.order!.externalCustomerReference,
          progress: readiness,
          customerQr: binCompletedNow ? `AYROVI:${bin.code}:${bin.order!.externalOrderReference}:${bin.order!.externalCustomerReference}` : null,
          locked: binCompletedNow,
        },
      };
    }).then(async (result) => {
      // Master Order §16: a completed customer container moves to the
      // packing step automatically — no admin re-creation.
      const completed = (result.flash as any).locked === true;
      if (completed) {
        await this.dispatch.onBinReady({ id: bin.id, code: bin.code }, actor.id, {
          reason: `customer container ${bin.code} complete and locked`,
        });
      }
      return result;
    });
  }

  // ------------------------------------------------------------------
  // 5. PACKING — bin -> verification -> outbound shipment
  // ------------------------------------------------------------------

  /** Scan the bin QR: shows customer + order + required vs present items. */
  async packingScanContainer(containerCode: string) {
    // Guard on miss: a carton identifier is rejected explicitly (409);
    // anything else keeps the original not-found (read-only scan).
    let bin;
    try {
      bin = await this.containerDetail(containerCode);
    } catch (e) {
      if (e instanceof NotFoundException) {
        await this.rejectIfCartonAtProductStation(containerCode, 'PACKING');
      }
      throw e;
    }
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
      where: { code: normalizeScan(containerCode).toUpperCase() },
      include: {
        order: { include: { items: { include: { product: true } } } },
        articles: { where: { status: 'IN_CUSTOMER_BIN' } },
      },
    });
    if (!bin) {
      await this.rejectIfCartonAtProductStation(containerCode, 'PACKING', actor);
      throw new NotFoundException(OPERATIONAL_ERRORS.containerNotFound);
    }
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
      await tx.$queryRaw`SELECT id FROM operational_containers WHERE id = ${bin.id} FOR UPDATE`;
      await this.assignments.assertOperationalAccess(actor.id, 'packing', { containerId: bin.id }, tx);
      const currentBin = await tx.operationalContainer.findUnique({ where: { id: bin.id } });
      if (!currentBin || currentBin.status !== 'READY_FOR_PACKING') throw new ConflictException('Container is not ready for packing or already packed.');
      const currentReadiness = await this.checkOrderCompleteness(tx, bin.order!.id);
      if (!currentReadiness.complete) throw new ConflictException('Order contents changed. Verify the container again.');
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
      await this.assignments.containerPacked(bin.id, actor.id, tx);
      return {
        flash: { kind: 'PACKED', shipment: code, order: bin.order!.externalOrderReference },
        shipment: {
          code,
          status: 'READY_TO_SHIP',
          carrier: carrierResult.carrier,
          trackingNumber: carrierResult.trackingNumber,
          labelValue: code, // internal label/QR — printed at the bench
        },
        shipmentId: shipment.id,
      };
    }).then(async (r) => {
      this.events.emit('packed', { shipment: r.shipment.code, order: bin.order!.externalOrderReference, actor: actor.id, t: Date.now() });
      // Master Order §16: after packing the next worker's task is SHIPPING —
      // created automatically from the created shipment, not by admin.
      await this.dispatch.onPacked(
        { id: r.shipmentId, code: r.shipment.code },
        actor.id,
        { reason: `order ${bin.order!.externalOrderReference} packed as ${r.shipment.code}` },
      );
      return r;
    });
  }

  // ------------------------------------------------------------------
  // 6+7. SHIPPING + CLEANUP (Master Order §17/§18)
  //
  //   SCAN CUSTOMER CONTAINER QR  (or OUT- label)
  //        ↓
  //   VERIFY CUSTOMER → VERIFY CONTAINER → VERIFY STATUS
  //        ↓
  //   SHIP — only with a valid, unexpired, content-bound verification
  // ------------------------------------------------------------------

  /**
   * Resolve a scan to an outbound shipment. Accepts:
   *   - an OUT- label code, or
   *   - a customer container QR (`AYROVI:BIN-…:ORDER:CUSTOMER`).
   */
  private async resolveShipmentByScan(rawCode: string) {
    const code = normalizeScan(rawCode).toUpperCase();
    if (!code) throw new BadRequestException(OPERATIONAL_ERRORS.shipmentNotFound);

    if (code.startsWith('AYROVI:')) {
      // Customer container QR: segment 2 is the bin code.
      const binCode = code.split(':')[1];
      const bin = binCode
        ? await this.prisma.operationalContainer.findUnique({ where: { code: binCode } })
        : null;
      if (!bin || bin.type !== 'CUSTOMER') throw new NotFoundException(OPERATIONAL_ERRORS.containerNotFound);
      const shipment = await this.prisma.outboundShipment.findFirst({
        where: { containerId: bin.id },
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { externalOrderReference: true, externalCustomerReference: true, customerName: true, customerSurname: true } },
          articles: { select: { code: true, sku: true, productName: true, status: true } },
          container: { select: { code: true, qrValue: true } },
        },
      });
      if (!shipment) throw new ConflictException(`Container ${bin.code} is not packed yet — no shipping label exists.`);
      return shipment;
    }

    const shipment = await this.prisma.outboundShipment.findUnique({
      where: { code },
      include: {
        order: { select: { externalOrderReference: true, externalCustomerReference: true, customerName: true, customerSurname: true } },
        articles: { select: { code: true, sku: true, productName: true, status: true } },
        container: { select: { code: true, qrValue: true } },
      },
    });
    if (!shipment) throw new NotFoundException(OPERATIONAL_ERRORS.shipmentNotFound);
    return shipment;
  }

  /**
   * Shipment resolution with the carton guard on miss: an unknown code that
   * turns out to be a carton identifier is rejected explicitly (409) instead
   * of a generic not-found.
   */
  private async resolveShipmentOrRejectCarton(
    rawCode: string,
    actor?: { id?: string | null; ip?: string | null },
  ) {
    try {
      return await this.resolveShipmentByScan(rawCode);
    } catch (e) {
      if (e instanceof NotFoundException) {
        await this.rejectIfCartonAtProductStation(rawCode, 'SHIPPING', actor);
      }
      throw e;
    }
  }

  /** Worker scans (label or customer QR) → the shipment card to verify. */
  async shippingScan(code: string) {
    const shipment = await this.resolveShipmentOrRejectCarton(code);
    return {
      code: shipment.code,
      status: shipment.status,
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      order: shipment.order,
      container: shipment.container ? { code: shipment.container.code, qr: shipment.container.qrValue } : null,
      articles: shipment.articles,
      packedAt: shipment.packedAt,
    };
  }

  /** Deterministic content hash over the shipment's article set. */
  private contentHashOf(articles: Array<{ code: string; sku: string }>): string {
    const canonical = articles.map((a) => `${a.code}|${a.sku}`).sort().join('\n');
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Pre-dispatch verification (Master Order §17): verify customer, container
   * and status, and create a short-lived verification bound to actor +
   * shipment + CONTENT HASH. Shipping without a valid verification is
   * rejected — no unverified dispatch.
   */
  async shippingVerify(code: string, actor: FulfillmentActor) {
    const shipment = await this.resolveShipmentOrRejectCarton(code, actor);
    if (shipment.status === 'SHIPPED') throw new ConflictException(OPERATIONAL_ERRORS.shipmentAlreadyShipped);
    if (!shipment.container) {
      throw new ConflictException('This shipment has no customer container to verify.');
    }
    // VERIFY CUSTOMER: a scanned QR carries the customer ref; it must agree
    // with the order (scanning an OUT- label skips this check).
    const scannedCustomer = normalizeScan(code).toUpperCase().split(':')[3] || '';
    if (scannedCustomer && normalizeScan(shipment.order.externalCustomerReference).toUpperCase() !== scannedCustomer) {
      throw new ConflictException(
        `CUSTOMER MISMATCH: this container belongs to ${shipment.order.externalCustomerReference}, not ${scannedCustomer}.`,
      );
    }

    const hash = this.contentHashOf(shipment.articles);
    const verification = await this.prisma.$transaction(async (tx) => {
      const row = await tx.shippingVerification.create({
        data: {
          outboundShipmentId: shipment.id,
          verifiedById: actor.id,
          contentHash: hash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'SHIPPING_VERIFIED' as never,
          entityType: 'outbound_shipment',
          entityId: shipment.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            shipment: shipment.code,
            verification: row.id,
            customer: shipment.order.externalCustomerReference,
            customerName: [shipment.order.customerName, shipment.order.customerSurname].filter(Boolean).join(' ') || null,
            container: shipment.container!.code,
            articles: shipment.articles.length,
            contentHash: hash,
          },
        },
        tx,
      );
      return row;
    });

    return {
      ok: true,
      verificationId: verification.id,
      verifiedAt: verification.createdAt.toISOString(),
      expiresAt: verification.expiresAt.toISOString(),
      shipment: {
        code: shipment.code,
        status: shipment.status,
        order: shipment.order,
        container: { code: shipment.container.code, qr: shipment.container.qrValue },
        articles: shipment.articles.length,
      },
    };
  }

  /** Dispatch: SHIPPED + container cleanup. Requires a valid verification. */
  async ship(code: string, actor: FulfillmentActor) {
    const shipment = await this.prisma.outboundShipment.findUnique({
      where: { code: normalizeScan(code).toUpperCase() },
      include: { order: true, container: true, articles: { select: { code: true, sku: true } } },
    });
    if (!shipment) {
      await this.rejectIfCartonAtProductStation(code, 'SHIPPING', actor);
      throw new NotFoundException(OPERATIONAL_ERRORS.shipmentNotFound);
    }
    if (shipment.status === 'SHIPPED') {
      throw new ConflictException(OPERATIONAL_ERRORS.shipmentAlreadyShipped);
    }

    // Verification gate: the most recent unused, unexpired verification for
    // this shipment, bound to the SAME content.
    const verification = await this.prisma.shippingVerification.findFirst({
      where: { outboundShipmentId: shipment.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!verification) {
      throw new ConflictException(`${OPERATIONAL_ERRORS.verificationRequired} (verify the container, then ship)`);
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      throw new ConflictException(OPERATIONAL_ERRORS.verificationExpired);
    }
    const currentHash = this.contentHashOf(shipment.articles);
    if (currentHash !== verification.contentHash) {
      throw new ConflictException('Shipment contents changed since verification. Verify the container again.');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM outbound_shipments WHERE id = ${shipment.id} FOR UPDATE`;
      await this.assignments.assertOperationalAccess(actor.id, 'shipping', { outboundShipmentId: shipment.id }, tx);
      const current = await tx.outboundShipment.findUnique({ where: { id: shipment.id } });
      if (!current || current.status !== 'READY_TO_SHIP') throw new ConflictException('Shipment already changed or shipped.');
      await tx.shippingVerification.update({
        where: { id: verification.id },
        data: { usedAt: new Date() },
      });
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
            customerName: [shipment.order.customerName, shipment.order.customerSurname].filter(Boolean).join(' ') || null,
            carrier: shipment.carrier,
            tracking: shipment.trackingNumber,
            verification: verification.id,
            contentHash: currentHash,
          },
        },
        tx,
      );
      await this.assignments.outboundShipped(shipment.id, actor.id, tx);
      return { flash: { kind: 'SHIPPED', shipment: shipment.code } };
    }).then(async (r) => {
      this.events.emit('shipped', { shipment: shipment.code, actor: actor.id, t: Date.now() });
      return r;
    });
  }

  // ------------------------------------------------------------------
  // 8. BORDEREAU — the shipping document (Master Order §18).
  //    Admin searches by customer name/surname, order reference,
  //    shipment number or container QR/reference and prints this.
  // ------------------------------------------------------------------

  async bordereau(code: string) {
    const shipment = await this.resolveShipmentOrRejectCarton(code);
    const order = await this.prisma.warehouseOrder.findUnique({
      where: { id: shipment.orderId },
      include: { items: { include: { product: { select: { name: true, externalProductCode: true } } } } },
    });
    const container = shipment.containerId
      ? await this.prisma.operationalContainer.findUnique({ where: { id: shipment.containerId } })
      : null;
    return {
      document: 'BORDEREAU / SHIPPING DOCUMENT',
      generatedAt: new Date().toISOString(),
      shipment: {
        code: shipment.code,
        status: shipment.status,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        packedAt: shipment.packedAt,
        shippedAt: shipment.shippedAt,
      },
      customer: {
        reference: order?.externalCustomerReference ?? null,
        name: order?.customerName ?? null,
        surname: order?.customerSurname ?? null,
      },
      order: {
        reference: order?.externalOrderReference ?? null,
        items: order?.items.map((i) => ({
          sku: i.product.externalProductCode,
          name: i.product.name,
          requested: i.requestedQuantity,
        })) ?? [],
      },
      container: container
        ? { code: container.code, label: container.label, qr: container.qrValue ?? null, status: container.status }
        : null,
      contents: shipment.articles.map((a) => ({ code: a.code, sku: a.sku, productName: a.productName, status: a.status })),
    };
  }

  /** Admin search across shipping documents: customer name/surname, order, shipment, QR. */
  async searchBordereau(q: string) {
    const term = normalizeScan(q).toUpperCase();
    if (!term) return [];
    return this.prisma.outboundShipment.findMany({
      where: {
        OR: [
          { code: { contains: term } },
          { trackingNumber: { contains: term } },
          { order: { externalOrderReference: { contains: term } } },
          { order: { externalCustomerReference: { contains: term } } },
          { order: { customerName: { contains: term, mode: 'insensitive' } } },
          { order: { customerSurname: { contains: term, mode: 'insensitive' } } },
          { container: { code: { contains: term } } },
          { container: { qrValue: { contains: term } } },
        ],
      },
      orderBy: { packedAt: 'desc' },
      take: 50,
      select: {
        code: true, status: true, trackingNumber: true, packedAt: true, shippedAt: true,
        order: { select: { externalOrderReference: true, externalCustomerReference: true, customerName: true, customerSurname: true } },
        container: { select: { code: true, qrValue: true } },
        _count: { select: { articles: true } },
      },
    });
  }

  // ------------------------------------------------------------------
  // REPORT PROBLEM — one worker-facing action at EVERY stage (Master Order
  // §14). The exception is a real row (OperationalException), immediately
  // visible on the Admin unified exceptions board, with an audited
  // RESOLVED/REJECTED lifecycle. Receiving keeps its session-scoped
  // discrepancies (existing pattern) — those are merged on the admin board.
  // ------------------------------------------------------------------

  private async genExceptionCode(tx: Prisma.TransactionClient) {
    for (let i = 0; i < 5; i += 1) {
      const count = await tx.operationalException.count();
      const code = `EXC-${String(count + 1 + i).padStart(6, '0')}`;
      if (!(await tx.operationalException.findUnique({ where: { code } }))) return code;
    }
    return `EXC-R${Date.now().toString().slice(-6)}`;
  }

  async reportProblem(
    input: { stage: string; entityType?: string; entityCode?: string; type?: string; reason: string },
    actor: FulfillmentActor,
  ) {
    const reason = normalizeScan(input.reason);
    if (!reason) throw new BadRequestException('Please describe the problem.');
    const code = normalizeScan(input.entityCode ?? '');
    const station = await this.prisma.station.findFirst({
      where: { assignedWorkerId: actor.id, status: 'ACTIVE' },
      select: { id: true, code: true },
    });
    return this.prisma.$transaction(async (tx) => {
      const excCode = await this.genExceptionCode(tx);
      const row = await tx.operationalException.create({
        data: {
          code: excCode,
          type: normalizeScan(input.type) || 'MANUAL_REPORT',
          status: 'OPEN',
          entityType: input.entityType ?? 'other',
          entityId: null,
          entityCode: code || null,
          reason: `${input.stage}: ${reason}`,
          reportedById: actor.id,
          stationId: station?.id ?? null,
        },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'EXCEPTION_CREATED' as never,
          entityType: 'operational_exception',
          entityId: row.id,
          ipAddress: actor.ip ?? null,
          metadata: {
            exception: row.code, stage: input.stage, type: row.type,
            entity: code || null, station: station?.code ?? null, reason,
          },
        },
        tx,
      );
      return { ok: true, code: row.code, status: row.status };
    });
  }

  /** Admin: unified operational exceptions (all stages, one board). */
  async listExceptions(filter: { status?: string; q?: string }) {
    const q = normalizeScan(filter.q).toUpperCase();
    return this.prisma.operationalException.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q } },
                { entityCode: { contains: q } },
                { reason: { contains: q, mode: 'insensitive' } },
                { type: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { station: { select: { code: true, name: true, department: true } } },
    });
  }

  /** Admin: resolve or reject an operational exception (audited). */
  async resolveException(exceptionId: string, resolution: 'RESOLVED' | 'REJECTED', note: string, actor: FulfillmentActor) {
    const final = resolution === 'RESOLVED' ? 'RESOLVED' : 'REJECTED';
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.operationalException.findUnique({ where: { id: exceptionId } });
      if (!row) throw new NotFoundException('Exception not found.');
      if (row.status !== 'OPEN') throw new ConflictException(`Exception ${row.code} is already ${row.status}.`);
      await tx.operationalException.update({
        where: { id: exceptionId },
        data: { status: final as never, resolvedById: actor.id, resolvedAt: new Date(), resolution: note || null },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          // One audit action for the lifecycle; the outcome is in metadata
          // (the AuditAction vocabulary is schema-defined, not free text).
          action: 'EXCEPTION_RESOLVED' as never,
          entityType: 'operational_exception',
          entityId: exceptionId,
          ipAddress: actor.ip ?? null,
          metadata: { exception: row.code, entity: row.entityCode ?? null, outcome: final, resolution: note || null },
        },
        tx,
      );
    });
    return { ok: true };
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

  /** Recent article units for the admin traceability board. */
  /** Admin board: recent outbound shipments with order/container/tracking. */
  async listOutboundShipments(filter: { status?: string; q?: string }) {
    const q = filter.q?.trim().toUpperCase();
    return this.prisma.outboundShipment.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(q
          ? {
              OR: [
                { code: { contains: q } },
                { trackingNumber: { contains: q } },
                { order: { externalOrderReference: { contains: q } } },
                { order: { externalCustomerReference: { contains: q } } },
              ],
            }
          : {}),
      },
      orderBy: { packedAt: 'desc' },
      take: 100,
      select: {
        code: true, status: true, carrier: true, trackingNumber: true,
        packedAt: true, shippedAt: true,
        order: { select: { externalOrderReference: true, externalCustomerReference: true } },
        container: { select: { code: true } },
        _count: { select: { articles: true } },
      },
    });
  }

  async listArticles(filter: { status?: string; q?: string }) {
    const q = filter.q?.trim().toUpperCase();
    return this.prisma.articleUnit.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(q ? { OR: [{ code: { contains: q } }, { sku: { contains: q } }] } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        code: true, sku: true, productName: true, category: true, subcategory: true,
        status: true, updatedAt: true,
        container: { select: { code: true, label: true } },
        currentLocation: { select: { locationCode: true } },
        order: { select: { externalOrderReference: true, externalCustomerReference: true } },
        outboundShipment: { select: { code: true, status: true } },
      },
    });
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

  /**
   * Product-article lookup with the carton guard on miss: an unknown code
   * that turns out to be a carton identifier is rejected explicitly (409);
   * anything else rethrows the original not-found.
   */
  private async getProductArticleOrRejectCarton(
    rawCode: string,
    station: 'SORTING' | 'ORDER_SORTING' | 'PACKING' | 'SHIPPING',
    actor?: { id?: string | null; ip?: string | null },
  ) {
    try {
      return await this.getArticle(normalizeScan(rawCode));
    } catch (e) {
      if (e instanceof NotFoundException) {
        await this.rejectIfCartonAtProductStation(rawCode, station, actor);
      }
      throw e;
    }
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
        // Order §24: case-insensitive at the boundary; stored code is authoritative.
        product: { externalProductCode: { equals: sku.trim().toUpperCase(), mode: 'insensitive' } },
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
