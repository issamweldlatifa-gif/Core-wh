/**
 * Scan-profile (P3) — pure, unit-tested data model that tells the scanner
 * *what* to read for an open card WITHOUT any manual configuration being typed
 * in code:
 *
 *   - mode     : what kind of value the card expects (SKU text / Reference /
 *                QR / barcode / carton), derived from the card's targetType.
 *   - prefixes : the code prefix(es) shared by this card's expected values
 *                (e.g. every SKU starts with "sb") — derived, not hard-coded,
 *                so new product families work without code changes.
 *   - frame    : which aiming frame the operator should see (product intent:
 *                square for QR, wide band for barcode, text strip for SKU/Ref).
 *
 * Everything here is pure data derivation; it never reads business state and
 * never makes decisions on its own (the scanner still validates every read
 * against the expected list before accepting).
 */

import type { ExpectedKind, ScanContext } from './scan-context';
import { normaliseExpected } from './scan-context';

/** A derived family prefix (leading run of letters) of an expected code. */
export function leadingAlphaPrefix(raw: string | null | undefined): string {
  const v = normaliseExpected(raw);
  if (!v) return '';
  const m = /^[A-Za-z]+/.exec(v);
  return m ? m[0] : '';
}

/** Longest common prefix of a list of strings ('' when none / trivial). */
export function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let p = values[0];
  for (let i = 1; i < values.length && p.length > 0; i++) {
    const v = values[i];
    let j = 0;
    while (j < p.length && j < v.length && p[j] === v[j]) j += 1;
    p = p.slice(0, j);
  }
  return p;
}

export type ScanProfileMode = 'SKU' | 'REFERENCE' | 'CARTON' | 'QR' | 'BARCODE' | 'MIXED';

export type AimFrameKind = 'square' | 'band' | 'strip';

export interface ScanProfile {
  /** What this card's expected set is made of (task type). */
  mode: ScanProfileMode;
  /** Code prefixes shared by ALL expected values ('' = none shared). */
  prefix: string;
  /** Human hint for the aiming chip, e.g. 'codes starting with sb'. */
  hint: string;
  /** Which aiming frame the operator should use. */
  frame: AimFrameKind;
  /** The kind most likely to be found (mirrors ScanContext.targetType). */
  expectedKind: ExpectedKind;
}

/** The expected kinds relevant to a task type (for prefix derivation). */
function kindsForProfile(mode: ScanProfileMode): ExpectedKind[] {
  switch (mode) {
    case 'SKU': return ['SKU'];
    case 'REFERENCE': return ['REFERENCE'];
    default: return ['CARTON', 'QR', 'BARCODE', 'REFERENCE'];
  }
}

const KIND_TO_PROFILE: Record<ExpectedKind, ScanProfileMode> = {
  CARTON: 'CARTON',
  SKU: 'SKU',
  REFERENCE: 'REFERENCE',
  QR: 'QR',
  BARCODE: 'BARCODE',
};

function frameFor(mode: ScanProfileMode): AimFrameKind {
  switch (mode) {
    case 'QR': return 'square';
    case 'BARCODE':
    case 'CARTON': return 'band';
    default: return 'strip'; // SKU / REFERENCE text
  }
}

/** Derive the scan profile from a card's prefetched expected context. */
export function deriveScanProfile(ctx: ScanContext): ScanProfile {
  const kind = ctx.targetType;
  const mode = KIND_TO_PROFILE[kind] ?? 'MIXED';
  // Derive the family prefix from the values OF THE SAME KIND the card targets
  // (e.g. SKU entries only) so a card that also lists references with other
  // prefixes does not water the SKU prefix down to ''.
  const relevant = kindsForProfile(mode);
  const values =
    ctx.entries.length > 0
      ? ctx.entries.filter((e) => relevant.includes(e.kind)).map((e) => e.value)
      : ctx.values;
  // Family prefix: the leading LETTER run shared by the card's codes (e.g. all
  // SKUs start 'sb'). Only trust one when every relevant expected code shares
  // it and it is at least 2 letters long — avoids narrowing on one shared char.
  const alphaPrefixes = [...new Set(values.map((v) => leadingAlphaPrefix(v)))].filter(Boolean);
  const prefix =
    values.length > 0 && alphaPrefixes.length === 1 && (alphaPrefixes[0] as string).length >= 2
      ? (alphaPrefixes[0] as string)
      : '';
  const isText = mode === 'SKU' || mode === 'REFERENCE';
  const hint = values.length === 0
    ? 'scan a code'
    : isText && prefix
      ? `scan ${mode === 'SKU' ? 'SKU' : 'reference'} · starts with ${prefix}`
      : isText
        ? `scan ${mode === 'SKU' ? 'SKU' : 'reference'}`
        : mode === 'CARTON' ? 'scan carton / QR / barcode' : `scan ${mode} code`;
  return { mode, prefix, hint, frame: frameFor(mode), expectedKind: kind };
}

export interface ProfileMatchFilter {
  /** True when the raw token plausibly belongs to this card (prefix gate). */
  accepts(raw: string | null | undefined): boolean;
}

/**
 * Build a cheap prefix filter for a profile. When the profile has a real shared
 * prefix we require it (kills noise lines like 'Made In China' immediately);
 * otherwise everything is accepted and the expected-list match does the work.
 */
export function profileFilterFor(profile: ScanProfile): ProfileMatchFilter {
  const textish = profile.mode === 'SKU' || profile.mode === 'REFERENCE';
  const p = textish ? profile.prefix : '';
  return {
    accepts: (raw) => {
      const v = normaliseExpected(raw);
      if (!v || v.length < 3) return false;
      if (p) return v.startsWith(p);
      return true;
    },
  };
}
