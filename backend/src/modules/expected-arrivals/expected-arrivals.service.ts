import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CustomerArrivalCardEventDto } from '../../integrations/crm/dto/customer-arrival-card.dto';

const WAR_PREFIX = 'WAR-';
const WAR_COUNTER_START = 1000; // human codes start at WAR-001000

export interface IntegrationPrincipal {
  kind: 'static' | 'api_client';
  id: string | null;
  name: string;
  idempotencyKey: string | null;
}

export interface ReceiveResult {
  success: true;
  customer_arrival_card_id: string;
  warehouse_arrival_id: string;
  status: 'EXPECTED';
  created: boolean; // false => duplicate (idempotent replay)
}

@Injectable()
export class ExpectedArrivalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Receive a Customer Arrival Card pushed by the Arrival CRM and persist it
   * as an EXPECTED arrival. Idempotent on the card id (and on Idempotency-Key
   * when provided): a repeated push returns the SAME Expected Arrival
   * without creating a second record.
   */
  async receiveCard(
    dto: CustomerArrivalCardEventDto,
    principal: IntegrationPrincipal,
    ip?: string | null,
  ): Promise<ReceiveResult> {
    const card = dto.customer_arrival_card;
    const cardId = card.id.trim();
    const products = card.products ?? [];

    // Payload sanity (the DTO/validation pipe already enforces shape).
    if (!products.length) {
      throw new BadRequestException('Customer arrival card contains no products.');
    }

    // --- Idempotency: card id is the primary anchor ---
    const existing = await this.prisma.expectedArrival.findUnique({
      where: { customerArrivalCardId: cardId },
    });
    if (existing) {
      // Replay of the same card -> return the same record (no new arrival).
      return {
        success: true,
        customer_arrival_card_id: cardId,
        warehouse_arrival_id: existing.code,
        status: 'EXPECTED',
        created: false,
      };
    }
    // Idempotency-Key header (if present) is a secondary guard.
    if (principal.idempotencyKey) {
      const byKey = await this.prisma.expectedArrival.findFirst({
        where: { idempotencyKey: principal.idempotencyKey },
      });
      if (byKey) {
        return {
          success: true,
          customer_arrival_card_id: cardId,
          warehouse_arrival_id: byKey.code,
          status: 'EXPECTED',
          created: false,
        };
      }
    }

    const totalUnits = products.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0);
    const now = new Date();

    // ---- Category validation against the Category Master (§ intake) ----
    // Known + ACTIVE -> CONFIRMED. Missing / 'UNCLASSIFIED' / unknown /
    // inactive -> NEEDS_REVIEW. An arbitrary string NEVER silently becomes a
    // classified category, and a NEEDS_REVIEW line is never treated as
    // classified downstream. One master lookup for the whole card.
    const requestedCodes = Array.from(
      new Set(
        products
          .map((p) => p.category?.trim().toUpperCase())
          .filter((c): c is string => !!c && c !== 'UNCLASSIFIED'),
      ),
    );
    const masterRows = requestedCodes.length
      ? await this.prisma.categoryMaster.findMany({ where: { code: { in: requestedCodes } } })
      : [];
    const master = new Map(masterRows.map((m) => [m.code, m]));

    const classify = (p: (typeof products)[number]) => {
      const code = p.category?.trim().toUpperCase() || null;
      const sub = p.subcategory?.trim().toUpperCase() || null;
      if (!code || code === 'UNCLASSIFIED') {
        return { category: code === 'UNCLASSIFIED' ? null : code, subcategory: sub, status: 'NEEDS_REVIEW' as const, reason: 'missing/unclassified' };
      }
      const m = master.get(code);
      if (!m) return { category: code, subcategory: sub, status: 'NEEDS_REVIEW' as const, reason: 'unknown category' };
      if (m.status !== 'ACTIVE') return { category: code, subcategory: sub, status: 'NEEDS_REVIEW' as const, reason: 'inactive category' };
      // Subcategory check: only when the master restricts subcategories.
      if (sub && m.subcategories.length > 0 && !m.subcategories.includes(sub)) {
        return { category: code, subcategory: sub, status: 'NEEDS_REVIEW' as const, reason: 'unknown subcategory' };
      }
      return { category: code, subcategory: sub, status: 'CONFIRMED' as const, reason: null };
    };
    const verdicts = products.map(classify);
    const needsReviewCount = verdicts.filter((v) => v.status === 'NEEDS_REVIEW').length;

    const arrival = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const code = await this.generateWarehouseCode(tx);
      const record = await tx.expectedArrival.create({
        data: {
          code,
          customerArrivalCardId: cardId,
          arrivalId: dto.arrival.id?.trim() || null,
          arrivalReference: dto.arrival.reference?.trim() || null,
          customerId: card.customer.id.trim(),
          customerName: card.customer.name.trim(),
          storeId: card.store?.id?.trim() || null,
          storeName: card.store?.name?.trim() || null,
          status: 'EXPECTED',
          source: 'ARRIVAL_CRM',
          productCount: products.length,
          totalUnits,
          apiClientId: principal.id,
          idempotencyKey: principal.idempotencyKey,
          receivedViaApi: true,
          receivedViaApiAt: now,
          items: {
            create: products.map((p, i) => ({
              productId: p.product_id?.trim() || null,
              sku: p.sku?.trim() || null,
              reference: p.reference?.trim() || null,
              productName: p.product_name?.trim() || null,
              quantity: Math.max(1, Math.floor(Number(p.quantity) || 1)),
              variant: p.variant?.trim() || null,
              color: p.color?.trim() || null,
              size: p.size?.trim() || null,
              // Validated classification (see classify() above). Never
              // inferred from the product name.
              category: verdicts[i].category,
              subcategory: verdicts[i].subcategory,
              classificationSource: p.classification_source?.trim() || null,
              categoryStatus: verdicts[i].status,
              storeId: p.store_id?.trim() || card.store?.id?.trim() || null,
              storeName: p.store_name?.trim() || card.store?.name?.trim() || null,
            })),
          },
        },
      });

      // Atomic audit row (same tx as the mutation).
      await this.audit.log(
        {
          actorUserId: null,
          action: 'CUSTOMER_ARRIVAL_CARD_RECEIVED' as never,
          entityType: 'expected_arrival',
          entityId: record.id,
          ipAddress: ip ?? null,
          metadata: {
            source: 'ARRIVAL_CRM',
            external_card_id: cardId,
            warehouse_arrival_id: record.code,
            status: 'SUCCESS',
            arrival: { id: record.arrivalId, reference: record.arrivalReference },
            customer: { id: record.customerId, name: record.customerName },
            store: { id: record.storeId, name: record.storeName },
            products: record.productCount,
            units: record.totalUnits,
            api_client: principal.name,
            received_via_api: true,
          },
        },
        tx,
      );

      // Classification traceability (same tx): one row per card summarising
      // the verdicts, plus an explicit NEEDS_REVIEW row when any line failed
      // validation so review queues can be driven off the audit stream.
      await this.audit.log(
        {
          actorUserId: null,
          action: 'CATEGORY_VALIDATED' as never,
          entityType: 'expected_arrival',
          entityId: record.id,
          ipAddress: ip ?? null,
          metadata: {
            external_card_id: cardId,
            confirmed: verdicts.filter((v) => v.status === 'CONFIRMED').length,
            needs_review: needsReviewCount,
            lines: verdicts.map((v, i) => ({
              sku: products[i].sku ?? null,
              category: v.category,
              subcategory: v.subcategory,
              classification_source: products[i].classification_source ?? null,
              status: v.status,
              reason: v.reason,
            })),
          },
        },
        tx,
      );
      if (needsReviewCount > 0) {
        await this.audit.log(
          {
            actorUserId: null,
            action: 'CATEGORY_NEEDS_REVIEW' as never,
            entityType: 'expected_arrival',
            entityId: record.id,
            ipAddress: ip ?? null,
            metadata: { external_card_id: cardId, lines_needing_review: needsReviewCount },
          },
          tx,
        );
      }

      return record;
    });

    return {
      success: true,
      customer_arrival_card_id: cardId,
      warehouse_arrival_id: arrival.code,
      status: 'EXPECTED',
      created: true,
    };
  }

  /**
   * Generate a unique human code `WAR-XXXXXXXX`. Counts existing rows so
   * codes are human-sequential; retries inside a transaction handle the
   * (rare) race. Only EXPECTED arrivals are numbered here — this is not the
   * later `warehouse_orders` sequence.
   */
  private async generateWarehouseCode(tx: Prisma.TransactionClient): Promise<string> {
    // Retry a few times to absorb a concurrent insert collision.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const count = await tx.expectedArrival.count();
      const number = WAR_COUNTER_START + count + 1;
      const code = `${WAR_PREFIX}${String(number).padStart(6, '0')}`;
      const clash = await tx.expectedArrival.findUnique({ where: { code } });
      if (!clash) return code;
    }
    // Fallback: time-based unique code if the counter contended repeatedly.
    const rand = Date.now().toString().slice(-6);
    return `${WAR_PREFIX}R${rand}`;
  }

  // ---- Read side (Warehouse UI), standard JWT + permission protected ----

  async list(filters: { status?: string; search?: string; take?: number; skip?: number }) {
    const where: Prisma.ExpectedArrivalWhereInput = {};
    if (filters.status) where.status = filters.status as never;
    const search = (filters.search ?? '').trim();
    if (search) {
      where.OR = [
        { code: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { storeName: { contains: search, mode: 'insensitive' } },
        { customerArrivalCardId: { contains: search, mode: 'insensitive' } },
      ];
    }
    const take = Math.min(filters.take ?? 50, 200);
    const skip = filters.skip ?? 0;
    const [data, total] = await Promise.all([
      this.prisma.expectedArrival.findMany({
        where,
        orderBy: { receivedViaApiAt: 'desc' },
        take,
        skip,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.expectedArrival.count({ where }),
    ]);
    return { data: data.map((r) => this.toListShape(r)), total, take, skip };
  }

  /**
   * Manual category resolution (audited: CATEGORY_MANUALLY_CHANGED).
   *
   * A supervisor resolves a NEEDS_REVIEW line (or corrects a wrong one) by
   * picking a category from the Category Master. Same rules as intake: the
   * category must exist and be ACTIVE, the subcategory must be allowed —
   * arbitrary text is rejected here exactly like on the card. The change is
   * propagated to the snapshots of any receiving session that is still open,
   * so the worker terminal reflects the resolution immediately.
   */
  async changeItemCategory(
    itemId: string,
    body: { category: string; subcategory?: string | null },
    actor: { id: string; ip?: string | null },
  ) {
    const item = await this.prisma.expectedArrivalItem.findUnique({
      where: { id: itemId },
      include: { arrival: { select: { id: true, code: true } } },
    });
    if (!item) throw new NotFoundException('Arrival item not found.');

    const code = (body.category ?? '').trim().toUpperCase();
    if (!code) throw new BadRequestException('Category is required.');
    const master = await this.prisma.categoryMaster.findUnique({ where: { code } });
    if (!master) throw new BadRequestException(`Category ${code} does not exist in the Category Master.`);
    if (master.status !== 'ACTIVE') throw new BadRequestException(`Category ${code} is INACTIVE.`);
    const sub = body.subcategory?.trim().toUpperCase() || null;
    if (sub && master.subcategories.length > 0 && !master.subcategories.includes(sub)) {
      throw new BadRequestException(`Subcategory ${sub} is not allowed under ${code}.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.expectedArrivalItem.update({
        where: { id: itemId },
        data: {
          category: code,
          subcategory: sub,
          classificationSource: 'MANUAL',
          categoryStatus: 'CONFIRMED' as never,
        },
      });
      // Keep open receiving-session snapshots in sync (completed sessions
      // keep their historical snapshot untouched).
      await tx.receivingProduct.updateMany({
        where: { arrivalItemId: itemId, session: { status: { in: ['RECEIVING', 'PAUSED'] as never[] } } },
        data: { category: code, subcategory: sub, categoryStatus: 'CONFIRMED' as never },
      });
      await this.audit.log(
        {
          actorUserId: actor.id,
          action: 'CATEGORY_MANUALLY_CHANGED' as never,
          entityType: 'expected_arrival_item',
          entityId: itemId,
          ipAddress: actor.ip ?? null,
          metadata: {
            arrival: item.arrival?.code ?? null,
            sku: item.sku,
            before: { category: item.category, subcategory: item.subcategory, status: item.categoryStatus },
            after: { category: code, subcategory: sub, status: 'CONFIRMED' },
          },
        },
        tx,
      );
      return updated;
    });
  }

  async detail(idOrCode: string) {
    const arrival = await this.prisma.expectedArrival.findFirst({
      where: { OR: [{ id: idOrCode }, { code: idOrCode }] },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!arrival) throw new NotFoundException('Expected arrival not found.');
    return this.toDetailShape(arrival);
  }

  private toListShape(r: {
    id: string; code: string; customerArrivalCardId: string; arrivalId: string | null;
    customerId: string; customerName: string; storeId: string | null; storeName: string | null;
    status: string; source: string; productCount: number; totalUnits: number;
    receivedViaApiAt: Date | null; createdAt: Date;
    _count?: { items: number };
  }) {
    return {
      id: r.id,
      warehouseArrivalId: r.code,
      code: r.code,
      customerArrivalCardId: r.customerArrivalCardId,
      arrivalId: r.arrivalId,
      customerId: r.customerId,
      customerName: r.customerName,
      storeId: r.storeId,
      storeName: r.storeName,
      status: r.status,
      source: r.source,
      products: r._count?.items ?? r.productCount,
      units: r.totalUnits,
      receivedViaApiAt: r.receivedViaApiAt ?? r.createdAt,
      createdAt: r.createdAt,
    };
  }

  private toDetailShape(arrival: any) {
    return {
      ...this.toListShape({ ...arrival, _count: { items: arrival.items?.length ?? arrival.productCount } }),
      arrivalReference: arrival.arrivalReference,
      receivedViaApi: arrival.receivedViaApi,
      apiClientId: arrival.apiClientId,
      idempotencyKey: arrival.idempotencyKey,
      items: (arrival.items ?? []).map((it: any) => ({
        id: it.id,
        productId: it.productId,
        sku: it.sku,
        reference: it.reference,
        productName: it.productName,
        quantity: it.quantity,
        variant: it.variant,
        color: it.color,
        size: it.size,
        category: it.category ?? null,
        subcategory: it.subcategory ?? null,
        classificationSource: it.classificationSource ?? null,
        categoryStatus: it.categoryStatus ?? 'NEEDS_REVIEW',
        storeId: it.storeId,
        storeName: it.storeName,
      })),
    };
  }
}
