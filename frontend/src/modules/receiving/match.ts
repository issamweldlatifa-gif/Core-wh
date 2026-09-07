/**
 * Receiving — DEVICE-SIDE MATCHING (card-based rebuild).
 *
 * The session downloads the expected CARD data (productCards / cartonCards).
 * A scanned or OCR-read identifier is matched LOCALLY against the active
 * lane's cards BEFORE anything is submitted:
 *   - PRODUCT lane: product card identifiers / SKU / reference.
 *   - CARTON lane:  carton card identifiers (external id / reference / QR /
 *     barcode) first, then the shipment-level TRACKING number (0 open ->
 *     all received, 1 open -> that carton, 2+ open -> ambiguous).
 *
 * The backend stays the FINAL authority (re-validates, persists, guards
 * duplicates, writes the worker activity log) — this module only decides
 * MATCH / MISMATCH / AMBIGUOUS on the device. The two card types are
 * independent and are never mixed here.
 *
 * Pure module: no DOM, unit-tested. Normalisation mirrors the backend
 * (backend/src/common/scan-normalizer.ts + ReceivingService.cardIdentifiers).
 */

import type { CartonCard, ProductCard } from './api';

/** Same whitespace normalisation the backend applies before comparing. */
export function normalizeTerm(s: string): string {
  return s.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Case-insensitive equality on usable codes (length >= 2). */
export function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').toUpperCase();
  const y = (b ?? '').toUpperCase();
  return x.length >= 2 && x === y;
}

/**
 * PRODUCT card match: the normalized scanned term must equal one of the
 * card's normalized identifiers, its SKU or its reference.
 */
export function matchProductCard(term: string, cards: ProductCard[]): ProductCard | null {
  const t = normalizeTerm(term);
  if (t.length < 2) return null;
  return (
    cards.find(
      (c) =>
        c.identifiers.includes(t) ||
        sameCode(c.sku, t) ||
        sameCode(c.reference, t),
    ) ?? null
  );
}

export type CartonMatch =
  | { result: 'card'; card: CartonCard; matchedOn: string }
  | { result: 'all-received'; card: CartonCard }
  | { result: 'ambiguous'; cartons: CartonCard[] }
  | { result: 'none' };

/**
 * CARTON card match:
 *   1) carton identity — external id / reference / QR / barcode (card identifiers);
 *   2) shipment-level TRACKING number — 0 open cartons -> all received,
 *      exactly 1 open -> that carton (matchedOn = 'TRACKING NUMBER'),
 *      2+ open -> ambiguous (the worker must scan the specific carton).
 */
export function matchCartonCard(term: string, cards: CartonCard[]): CartonMatch {
  const t = normalizeTerm(term);
  if (t.length < 2) return { result: 'none' };
  const direct = cards.find(
    (c) =>
      c.identifiers.includes(t) ||
      sameCode(c.externalCartonId, t) ||
      sameCode(c.reference, t) ||
      sameCode(c.qrCodeValue, t) ||
      sameCode(c.barcodeValue, t),
  );
  if (direct) return { result: 'card', card: direct, matchedOn: 'CARTON' };
  const byTracking = cards.filter((c) => sameCode(c.trackingNumber, t));
  if (byTracking.length === 0) return { result: 'none' };
  const open = byTracking.filter((c) => c.status !== 'RECEIVED');
  if (open.length === 0) return { result: 'all-received', card: byTracking[0] };
  if (open.length === 1) return { result: 'card', card: open[0], matchedOn: 'TRACKING NUMBER' };
  return { result: 'ambiguous', cartons: open };
}
