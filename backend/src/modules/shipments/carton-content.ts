import { Prisma } from '@prisma/client';

/**
 * CARTON CONTENT — link products inside a carton to the expected arrival
 * WITHOUT double counting the customer card.
 *
 * Why this exists (acceptance-tested fix):
 *   The Arrival CRM pushes the SAME product lines twice for one physical
 *   arrival:
 *     1. on the Customer Arrival Card (authoritative expectation), and
 *     2. repeated inside each Shipment/Carton card as the per-carton manifest.
 *   Receiving aggregates ExpectedArrivalItem rows by SKU/reference, so naive
 *   item creation for every carton manifest line inflated the expected
 *   quantity (10 units became 20) and the receiving report then reported
 *   products MISSING that had physically arrived.
 *
 * Policy (link first, create only what is genuinely absent):
 *   - a manifest line whose product identity (SKU, or product_id, or
 *     reference when no SKU exists anywhere) already has an arrival-level
 *     item (cartonId IS NULL) is a MIRROR of that line: nothing new is
 *     created, nothing is counted twice;
 *   - a manifest line with NO arrival-level item (content beyond the
 *     customer card) is real additional content: it is created and linked to
 *     this carton so the floor can still scan/verify it.
 *
 * Carton identity itself is untouched (carton-level flows are separate).
 */
export interface LinkCartonProductsInput {
  tx: Prisma.TransactionClient;
  arrivalId: string;
  cartonId: string;
  products: Array<Record<string, unknown>>;
}

export interface LinkCartonProductsResult {
  created: number;
  /** Manifest lines already declared on the arrival card (mirror, not counted twice). */
  mirrored: number;
}

/** Returns the rows actually stored in the carton's item relation (created only). */
export async function linkCartonProductContents(
  input: LinkCartonProductsInput,
): Promise<LinkCartonProductsResult> {
  let created = 0;
  let mirrored = 0;
  const items = Array.isArray(input.products) ? input.products : [];
  for (const raw of items) {
    const p = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : null) || null;
    const sku = str(p.sku);
    const reference = str(p.reference);
    const productId = str(p.product_id);
    if (sku || productId || reference) {
      // Identity conditions against arrival-level lines only (cartonId null).
      const identity: Prisma.ExpectedArrivalItemWhereInput[] = [];
      if (sku) identity.push({ sku });
      if (productId) identity.push({ productId });
      // Reference is only authoritative when neither side carries a SKU:
      // an arrival line with SKU is matched by the SKU above.
      if (!sku && !productId && reference) identity.push({ reference });
      const existing = await input.tx.expectedArrivalItem.findFirst({
        where: { arrivalId: input.arrivalId, cartonId: null, OR: identity },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (existing) {
        // Mirror of the Customer Arrival Card line — skip to avoid the
        // quantity inflation (receiving aggregates by SKU/reference).
        mirrored += 1;
        continue;
      }
    }
    await input.tx.expectedArrivalItem.create({
      data: {
        arrivalId: input.arrivalId,
        cartonId: input.cartonId,
        productId: str(p.product_id),
        sku,
        reference,
        productName: str(p.product_name) ?? str(p.productName),
        quantity: Math.max(1, Math.floor(Number(p.quantity)) || 1),
        variant: str(p.variant),
        color: str(p.color),
        size: str(p.size),
        category: str(p.category)?.toUpperCase() ?? null,
        subcategory: str(p.subcategory)?.toUpperCase() ?? null,
        storeId: str(p.store_id) ?? str(p.storeId),
        storeName: str(p.store_name) ?? str(p.storeName),
        originalPayload: JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue,
        categoryStatus: 'NEEDS_REVIEW',
      },
    });
    created += 1;
  }
  return { created, mirrored };
}
