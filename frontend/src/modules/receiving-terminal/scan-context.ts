/**
 * Receiving — prefetch ScanContext (final order §5–§7, §11, §30).
 *
 * Built the moment the Receiving card loads, BEFORE the worker scans:
 * expected values of the session are collected, normalised ONCE (comparison-
 * ready), and held in memory. The frame/OCR loop compares against THIS local
 * context — no per-frame backend call, no DB query per OCR attempt, no scan
 * over the whole database (§30). The backend is only used afterwards to record
 * / confirm the operation, exactly as the existing receiving architecture does.
 *
 * Pure module: no DOM, unit-tested. Normalisation uses the SAME normaliseToken
 * the recognition loop applies to OCR reads, so expected values and observed
 * values are compared on the same representation.
 */

import { cleanCode } from './validate';
import { normaliseToken } from './normalize';

export type ScanMode = 'CARTON' | 'PRODUCT';
/** What the worker is expected to present at this station, when known. */
export type ExpectedKind = 'CARTON' | 'SKU' | 'REFERENCE' | 'QR' | 'BARCODE';

export interface CartonExpectedSource {
  externalCartonId?: string | null;
  reference?: string | null;
  qrCodeValue?: string | null;
  barcodeValue?: string | null;
}
export interface ProductExpectedSource {
  sku?: string | null;
  reference?: string | null;
}

export interface ScanContextInput {
  mode: ScanMode;
  cartons?: CartonExpectedSource[];
  products?: ProductExpectedSource[];
}

export interface ExpectedEntry {
  /** comparison-ready value (already normalised). */
  value: string;
  /** original value as supplied (for display / telemetry). */
  raw: string;
  kind: ExpectedKind;
}

export interface ScanContext {
  mode: ScanMode;
  builtAt: number;
  /** number of distinct expected records the source provided. */
  sourceRecords: number;
  entries: ExpectedEntry[];
  /** distinct normalised values — the local comparison kernel (§11). */
  values: string[];
  /** lookup map value → first entry (O(1) local match). */
  byValue: Map<string, ExpectedEntry>;
  /** what this session expects the worker to point at (for guidance/telemetry). */
  targetType: 'CARTON' | 'SKU' | 'REFERENCE';
}

export const EMPTY_SCAN_CONTEXT: ScanContext = {
  mode: 'CARTON',
  builtAt: 0,
  sourceRecords: 0,
  entries: [],
  values: [],
  byValue: new Map(),
  targetType: 'CARTON',
};

/**
 * Normalise an expected raw value into comparison-ready form. Same rules the
 * OCR path applies (uppercase, strip anything outside [A-Z0-9-], drop edge
 * dashes). Values shorter than 2 chars are dropped (not plausible codes).
 */
export function normaliseExpected(raw: string | null | undefined): string {
  return normaliseToken(cleanCode(raw ?? ''));
}

/** Make ONE normalised, de-duplicated expected value, or '' when unusable. */
function addEntry(
  byValue: Map<string, ExpectedEntry>,
  raw: string | null | undefined,
  kind: ExpectedKind,
): void {
  const value = normaliseExpected(raw);
  if (value.length < 2) return;
  if (byValue.has(value)) return;
  byValue.set(value, { value, raw: raw ?? '', kind });
}

/**
 * Build the in-memory scan context for a session (§5/§6/§7).
 * CARTON mode expects carton identity (external id + QR + barcode + reference);
 * PRODUCT mode expects product SKUs and references. Expected values are
 * normalised here, once, up-front.
 */
export function buildScanContext(input: ScanContextInput): ScanContext {
  const byValue = new Map<string, ExpectedEntry>();
  const cartons = input.cartons ?? [];
  const products = input.products ?? [];
  let sourceRecords = 0;

  if (input.mode === 'CARTON') {
    for (const c of cartons) {
      sourceRecords += 1;
      addEntry(byValue, c.externalCartonId, 'CARTON');
      addEntry(byValue, c.qrCodeValue, 'QR');
      addEntry(byValue, c.barcodeValue, 'BARCODE');
      addEntry(byValue, c.reference, 'REFERENCE');
    }
  } else {
    for (const p of products) {
      sourceRecords += 1;
      addEntry(byValue, p.sku, 'SKU');
      addEntry(byValue, p.reference, 'REFERENCE');
    }
  }

  const entries = [...byValue.values()];
  const values = entries.map((e) => e.value);
  const targetType: ScanContext['targetType'] =
    input.mode === 'CARTON' ? 'CARTON' : products.some((p) => p.sku) ? 'SKU' : 'REFERENCE';

  return {
    mode: input.mode,
    builtAt: Date.now(),
    sourceRecords,
    entries,
    values,
    byValue,
    targetType,
  };
}

/** True when the context has nothing to compare against yet. */
export function isEmptyContext(ctx: ScanContext): boolean {
  return !ctx || ctx.values.length === 0;
}

/** Local, O(1) expected-value check — never touches the backend (§11/§30). */
export function localExpectedMatch(
  ctx: ScanContext,
  rawObserved: string,
): { matched: boolean; entry?: ExpectedEntry } {
  if (isEmptyContext(ctx)) return { matched: false };
  const value = normaliseExpected(rawObserved);
  if (!value) return { matched: false };
  const entry = ctx.byValue.get(value);
  return entry ? { matched: true, entry } : { matched: false };
}

/** Human label of what this session expects (guidance). */
export function expectedHint(ctx: ScanContext): string {
  if (isEmptyContext(ctx)) return 'scan a code';
  if (ctx.targetType === 'CARTON') return 'carton / QR / barcode';
  if (ctx.targetType === 'SKU') return 'product SKU';
  return 'product reference';
}
