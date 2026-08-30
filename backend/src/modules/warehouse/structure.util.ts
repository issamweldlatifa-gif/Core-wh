/**
 * Shared helpers for the Phase 1 physical warehouse structure.
 *
 * These are pure, dependency-free functions used by the per-resource
 * services to keep code/identifier rules consistent everywhere.
 */

/** Uppercase, no surrounding whitespace. Codes are stored uppercase. */
export function normalizeCode(code: string): string {
  return (code ?? '').trim().toUpperCase();
}

/**
 * Level display code derived from the numeric order (D-36).
 *   1 -> L01, 2 -> L02, ... 99 -> L99, 100 -> L100.
 */
export function levelCodeFromNumber(n: number): string {
  const num = Math.max(1, Math.floor(n));
  return `L${String(num).padStart(2, '0')}`;
}

/**
 * Location code convention (D-30, LOCKED):
 *   {WAREHOUSE}-{ZONE}-{AISLE}-{RACK}-{LEVEL}
 * e.g. TUN-MAIN-SHOES-A01-R02-L03
 * Uppercase + hyphen separated, derived from the parent chain, read-only.
 */
export function buildLocationCode(
  warehouseCode: string,
  zoneCode: string,
  aisleCode: string,
  rackCode: string,
  levelCode: string,
): string {
  return [warehouseCode, zoneCode, aisleCode, rackCode, levelCode]
    .map(normalizeCode)
    .filter(Boolean)
    .join('-');
}

/** Validates an aggregate location code string has the right shape. */
export const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/;
