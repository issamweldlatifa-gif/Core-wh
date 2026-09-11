import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface IntegrationPrincipal {
  kind: 'static' | 'api_client';
  id: string | null;
  name: string;
  idempotencyKey: string | null;
}

@Injectable()
export class ExpectedArrivalsService {
  private readonly logger = new Logger(ExpectedArrivalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
      include: { 
        items: { orderBy: { createdAt: 'asc' } },
        shipments: { include: { cartons: { orderBy: { cartonNumber: 'asc' } } } },
      },
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
        cartonId: it.cartonId ?? null,
        originalPayload: it.originalPayload ?? null,
      })),
      shipments: (arrival.shipments ?? []).map((s: any) => ({
        id: s.id,
        code: s.code,
        externalShipmentId: s.externalShipmentId,
        trackingNumber: s.trackingNumber,
        suiviCode: s.suiviCode ?? s.trackingNumber,
        carrierName: s.carrierName,
        totalCartons: s.totalCartons,
        cartons: (s.cartons ?? []).map((c: any) => ({
          id: c.id,
          externalCartonId: c.externalCartonId,
          reference: c.cartonReference,
          qrCodeValue: c.qrCodeValue,
          barcodeValue: c.barcodeValue,
          suiviCode: c.suiviCode ?? s.suiviCode ?? s.trackingNumber,
          trackingCode: c.trackingCode ?? c.suiviCode ?? s.trackingNumber,
          entityType: c.entityType ?? 'CARTON',
          productCount: c.productCount,
          sourceProject: c.sourceProject ?? s.sourceProject,
          status: c.status,
          metadata: c.metadata,
          originalPayload: c.originalPayload,
        })),
      })),
    };
  }
}
