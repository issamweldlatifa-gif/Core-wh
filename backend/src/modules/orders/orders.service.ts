import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Orders API over the EXISTING Phase-2 order projection models
 * (WarehouseOrder / OrderItem / Product). Discovery finding: those models
 * existed in the schema ONLY — no service or controller anywhere used them.
 * This service does NOT redesign them; it is the missing intake/read layer:
 *
 *  - intake(): idempotent upsert keyed on externalOrderReference (C2) with
 *    the living contentHash (D-56B/D-65). Same event replayed -> no-op.
 *  - list()/detail(): read surface for admin + the order-sorting terminal.
 *
 * References are normalized trim + UPPERCASE per D-64.
 */

export interface OrderIntakeInput {
  externalOrderReference: string;
  externalCustomerReference: string;
  source?: 'ADMIN' | 'CRM' | 'OCR' | 'API';
  note?: string | null;
  items: Array<{
    store: string;
    externalProductCode: string;
    productName: string;
    requestedQuantity: number;
    externalLineReference?: string | null;
  }>;
}

const norm = (s: string) => (s || '').trim().toUpperCase();

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private contentHash(input: OrderIntakeInput) {
    const canonical = {
      customer: norm(input.externalCustomerReference),
      items: input.items
        .map((i) => ({
          store: norm(i.store),
          code: norm(i.externalProductCode),
          qty: i.requestedQuantity,
          line: i.externalLineReference ? norm(i.externalLineReference) : null,
        }))
        .sort((a, b) => (a.code + a.store).localeCompare(b.code + b.store)),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  async intake(input: OrderIntakeInput, actorLabel: string, ip?: string | null) {
    const ref = norm(input.externalOrderReference);
    const customer = norm(input.externalCustomerReference);
    if (!ref || !customer) {
      throw new BadRequestException('externalOrderReference and externalCustomerReference are required.');
    }
    if (!input.items?.length) throw new BadRequestException('At least one item is required.');

    const hash = this.contentHash(input);
    const existing = await this.prisma.warehouseOrder.findUnique({
      where: { externalOrderReference: ref },
      include: { items: true },
    });

    // Idempotency: identical replay is a no-op ACK.
    if (existing && existing.contentHash === hash) {
      return { orderId: existing.id, reference: ref, outcome: 'UNCHANGED' as const };
    }

    return this.prisma.$transaction(async (tx) => {
      // Upsert products by their (store, externalProductCode) identity (C1).
      const productIds: string[] = [];
      for (const item of input.items) {
        const product = await tx.product.upsert({
          where: {
            store_externalProductCode: {
              store: norm(item.store),
              externalProductCode: norm(item.externalProductCode),
            },
          },
          create: {
            store: norm(item.store),
            externalProductCode: norm(item.externalProductCode),
            name: item.productName?.trim() || norm(item.externalProductCode),
          },
          update: {},
        });
        productIds.push(product.id);
      }

      let orderId: string;
      let outcome: 'CREATED' | 'UPDATED';
      if (!existing) {
        const order = await tx.warehouseOrder.create({
          data: {
            externalOrderReference: ref,
            externalCustomerReference: customer,
            source: (input.source ?? 'API') as never,
            note: input.note ?? null,
            contentHash: hash,
          },
        });
        orderId = order.id;
        outcome = 'CREATED';
      } else {
        await tx.warehouseOrder.update({
          where: { id: existing.id },
          data: { externalCustomerReference: customer, note: input.note ?? existing.note, contentHash: hash },
        });
        // Living update: replace OPEN lines only if nothing is fulfilled yet.
        const fulfilled = await tx.articleUnit.count({
          where: { orderId: existing.id, status: { in: ['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'] } },
        });
        if (fulfilled > 0) {
          throw new BadRequestException(
            `Order ${ref} already has fulfilled articles — content update rejected.`,
          );
        }
        await tx.orderItem.deleteMany({ where: { orderId: existing.id } });
        orderId = existing.id;
        outcome = 'UPDATED';
      }

      for (let i = 0; i < input.items.length; i += 1) {
        const item = input.items[i];
        if (!Number.isInteger(item.requestedQuantity) || item.requestedQuantity < 1) {
          throw new BadRequestException(`Item ${item.externalProductCode}: requestedQuantity must be >= 1.`);
        }
        await tx.orderItem.create({
          data: {
            orderId,
            productId: productIds[i],
            requestedQuantity: item.requestedQuantity,
            externalLineReference: item.externalLineReference ? norm(item.externalLineReference) : null,
          },
        });
      }

      await this.audit.log(
        {
          actorUserId: null,
          action: outcome === 'CREATED' ? 'WAREHOUSE_ORDER_CREATED' : 'WAREHOUSE_ORDER_UPDATED',
          entityType: 'warehouse_order',
          entityId: orderId,
          ipAddress: ip ?? null,
          metadata: { reference: ref, customer, source: input.source ?? 'API', by: actorLabel, items: input.items.length },
        },
        tx,
      );

      return { orderId, reference: ref, outcome };
    });
  }

  async list(filter: { status?: string; q?: string }) {
    return this.prisma.warehouseOrder.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.q
          ? {
              OR: [
                { externalOrderReference: { contains: norm(filter.q) } },
                { externalCustomerReference: { contains: norm(filter.q) } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        _count: { select: { items: true, containers: true, outboundShipments: true } },
      },
    });
  }

  async detail(reference: string) {
    const order = await this.prisma.warehouseOrder.findUnique({
      where: { externalOrderReference: norm(reference) },
      include: {
        items: { include: { product: true } },
        containers: { select: { code: true, type: true, status: true, label: true } },
        outboundShipments: {
          select: { code: true, status: true, carrier: true, trackingNumber: true, shippedAt: true },
        },
        articleUnits: { select: { code: true, sku: true, status: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found.');
    return order;
  }
}
