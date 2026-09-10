/**
 * SCAN NORMALIZATION — the single authoritative boundary (Master Order §24).
 *
 * BEFORE: the Web terminal uppercased + trimmed; the native app only trimmed;
 * the backend matched case-sensitively. The same valid code could fail solely
 * because CT40 and Web formatted it differently.
 *
 * AFTER: every scanned value is normalized HERE, at the backend edge, exactly
 * once, before any lookup. The stored identifiers are NEVER rewritten —
 * normalization only makes the comparison deterministic:
 *
 *   1. trim leading/trailing whitespace
 *   2. strip CR / LF / TAB (scanner drivers append a line terminator)
 *   3. collapse internal whitespace runs to a single space
 *   4. comparison is case-insensitive for OPERATIONAL CODES (see
 *      `caseInsensitiveCodes`) — internal codes are generated UPPERCASE and
 *      CRM-provided codes are compared case-insensitively as well, because a
 *      floor scan must not fail on case. Case that is meaningful is preserved
 *      in STORAGE: we only change the lookup, never the stored value.
 *
 * The scanner (scanner-core / web scanner stack) only PRODUCES scan input;
 * it contains no business matching logic (Order §25).
 */

/**
 * Normalize a raw scanner/manual input to its canonical comparison form.
 * Returns '' for null/undefined/empty.
 */
export function normalizeScan(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .replace(/[\r\n\t]/g, ' ') // scanner line terminators
    .replace(/\s+/g, ' ') // collapse internal runs
    .trim();
}

/**
 * True when two scanned identifiers denote the same operational code,
 * regardless of case and surrounding/line-terminator whitespace.
 */
export function sameScanCode(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeScan(a).toUpperCase();
  const nb = normalizeScan(b).toUpperCase();
  return na.length > 0 && na === nb;
}

/**
 * Prisma where-clause fragment for a case-insensitive, whitespace-tolerant
 * exact match on one or more candidate columns. Usage:
 *
 *   const code = normalizeScan(raw);
 *   where: { OR: codeMatches(code, ['externalCartonId', 'qrCodeValue']) }
 *
 * (PostgreSQL `mode: 'insensitive'` is ASCII case-insensitive, which is the
 * intended semantics for operational codes.)
 */
export function codeMatches(
  code: string,
  columns: Array<'externalCartonId' | 'qrCodeValue' | 'barcodeValue' | 'cartonReference' | 'sku' | 'reference' | 'code' | 'locationCode' | 'barcodeValue' | 'qrValue' | 'externalOrderReference' | 'externalProductCode' | 'trackingNumber'>,
) {
  const canonical = normalizeScan(code).toUpperCase();
  if (!canonical) return undefined;
  const eq: any = { equals: canonical, mode: 'insensitive' };
  return columns.map((c) => ({ [c]: eq }));
}

/**
 * Operational error messages (Master Order §35). Workers get an actionable,
 * non-technical message; the technical detail stays in logs/audit. These
 * replace raw exceptions like "ExpectedArrival.findFirst returned null".
 */
export const OPERATIONAL_ERRORS = {
  arrivalNotAvailable: 'Arrival not available. Select an active arrival.',
  sessionClosed: 'This receiving task is closed. Select an open task.',
  cartonUnknown: 'Unknown carton. This carton is not part of any announced shipment.',
  cartonWrongShipment: 'Wrong shipment. This carton belongs to a different arrival.',
  cartonDuplicate: 'Carton already received.',
  cartonNotExpected: 'This carton is not expected for this arrival.',
  productNotMatched: 'Product does not match this arrival.',
  productAlreadyComplete: 'This product line is complete. Do not add more units.',
  unitAlreadyScanned: 'This unit was already received. Scan the next unit.',
  containerNotFound: 'Container not recognized. Scan a valid container QR.',
  containerWrongType: 'Wrong container type for this operation.',
  containerClosed: 'Container is closed. Use the next container.',
  containerFull: 'Container is full. Close it and continue with a next container.',
  articleNotFound: 'Article not recognized. Scan a valid article QR.',
  articleNotReady: 'This article is not waiting for this step.',
  binWrongCustomer: 'Wrong bin. This product does not belong to this customer container.',
  binClosed: 'This customer container is complete and locked.',
  locationNotFound: 'Location not recognized. Scan a valid location barcode.',
  locationUnavailable: 'This location is not available. Choose another location.',
  locationWrongZone: 'Wrong zone. This product is configured for a different zone.',
  shipmentNotFound: 'Shipment not recognized. Scan a valid shipping label.',
  shipmentAlreadyShipped: 'This shipment was already dispatched.',
  verificationRequired: 'Shipping verification required. Verify the container first.',
  verificationExpired: 'Verification expired. Verify the container again.',
  reviewRequired: 'Manual review required. Ask a supervisor.',
  stationRequired: 'This task requires your assigned station.',
  notAssigned: 'This work is not assigned to you. Ask a supervisor.',
} as const;

export type OperationalErrorCode = keyof typeof OPERATIONAL_ERRORS;
