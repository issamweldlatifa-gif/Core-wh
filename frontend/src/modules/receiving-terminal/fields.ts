/**
 * Field-aware OCR extraction — order §8.
 *
 * OCR output is not treated as one blob of text. Lines are split and each
 * plausible code token is classified into a business field:
 *
 *   ARTICLE_ID / SKU · CARTON · TRACKING · ORDER · CUSTOMER_REF
 *
 * Field rules below are deliberately WEAK PRIORS. The project does not assume
 * one universal identifier format (§21 in the codebase spec); the AYROVI
 * corpus (expected cartons + expected products of the receiving session) is
 * the only authority for what is real. These rules exist only to (a) skip
 * shipping-label stopwords, (b) prefer the field most relevant to what is
 * being scanned (carton vs product), and (c) feed a small format-plausibility
 * score into the confidence model.
 */

export type FieldKind = 'ARTICLE' | 'CARTON' | 'TRACKING' | 'ORDER' | 'CUSTOMER_REF' | 'UNKNOWN';
export type LabelKind = 'CARTON' | 'PRODUCT';

export interface FieldToken {
  token: string; // raw, upper-cased candidate as OCR saw it
  field: FieldKind;
  /** weak 0..1 plausibility hint for the format of THAT field */
  formatScore: number;
}

/** Labels that are never identifiers (shipping boilerplate). */
const STOPWORDS = new Set([
  'MADEIN', 'MADE', 'CHINA', 'ITALY', 'FRANCE', 'TUNISIA', 'TURKEY', 'SPAIN',
  'QTY', 'PCS', 'CTN', 'CARTON', 'BOX', 'TOTAL', 'SIZE', 'COLOR', 'COLOUR',
  'WEIGHT', 'NET', 'GROSS', 'FRAGILE', 'THIS', 'SIDE', 'UP', 'CARE', 'HANDLE',
  'INVOICE', 'ORDER', 'DATE', 'SHIP', 'TRACKING', 'FROM', 'TO', 'BARCODE', 'REF',
  'REFERENCE', 'CUSTOMER', 'SUPPLIER', 'VENDOR', 'LOT', 'BATCH', 'ARTICLE',
  'PRODUCT', 'SKU', 'QTY', 'NUMBER', 'NO', 'PART', 'DESC', 'DESCRIPTION',
  'MODEL', 'TYPE', 'STYLE', 'PO', 'SO', 'PCS', 'PC', 'EACH', 'DOZ', 'UNIT',
]);

/** Which field is most wanted when scanning each kind of label.
 *  (SKUs are OCR'd as ARTICLE tokens; there is no separate SKU field kind —
 *  only the AYROVI corpus can confirm that an ARTICLE token is a real SKU.) */
const PRIORITY: Record<LabelKind, FieldKind[]> = {
  CARTON: ['CARTON', 'ARTICLE', 'TRACKING', 'CUSTOMER_REF', 'ORDER'],
  PRODUCT: ['ARTICLE', 'CARTON', 'TRACKING', 'ORDER'],
};

/** Weak field recognisers. Order matters — first match wins per token. */
interface FieldRule {
  kind: FieldKind;
  /** must match the whole token */
  test: RegExp;
  formatScore: number;
  needsDigit: boolean;
}

function fmtScore(length: number, digitRatio: number): number {
  let s = 0.5;
  if (length >= 6 && length <= 24) s += 0.2;
  if (digitRatio > 0.25 && digitRatio < 0.95) s += 0.15;
  return Math.min(1, s);
}

/** Generic structural rules — broad on purpose (no universal format). */
const FIELD_RULES: FieldRule[] = [
  // CARTON-like: CARTON/CTN/BOX-ish prefix with number, or hyphen runs.
  { kind: 'CARTON', test: /^(CARTON|CTN|BOX|CRT|CASE|PAL)-?[A-Z0-9]{2,12}$/, formatScore: 0.95, needsDigit: false },
  // Tracking numbers: 1Z…/3S…/9V… UPS-style or long mixed runs with digits.
  { kind: 'TRACKING', test: /^(1Z|3S|9V|420|96|82|JD|RA|EA|SI)\s?[A-Z0-9]{2,}[A-Z0-9]$/, formatScore: 0.9, needsDigit: true },
  // Order references: ORD/PO/SO/CO/DO followed by digits (with optional -/ /_).
  { kind: 'ORDER', test: /^(ORD|PO|SO|CO|DO|WO|MO|BO|RO|REF)-?[A-Z0-9-]{3,16}$/, formatScore: 0.92, needsDigit: true },
  // Long digit runs (>=10) — usually tracking/serial not SKU.
  { kind: 'TRACKING', test: /^\d{10,30}$/, formatScore: 0.7, needsDigit: true },
];

/** Split OCR text into candidate tokens classified by field. */
export function extractFieldTokens(text: string): FieldToken[] {
  if (!text) return [];
  const lines = text
    .toUpperCase()
    .replace(/[|_]/g, ' ')
    .split(/\r?\n|  +|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: FieldToken[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // Try the whole line as one reference first (single-code labels).
    const whole = cleanToken(line);
    if (whole) {
      const ft = classifyToken(whole);
      if (ft) {
        if (!seen.has(whole)) {
          seen.add(whole);
          out.push(ft);
        }
        continue;
      }
    }
    // Otherwise split into words / hyphen runs.
    const words = line.split(/\s+/);
    for (const raw of words) {
      const w = cleanToken(raw);
      if (!w || w.length < 3) continue;
      if (STOPWORDS.has(w)) continue;
      if (!/[A-Z0-9-]/.test(w)) continue;
      if (seen.has(w)) continue;
      const ft = classifyToken(w);
      if (!ft) continue;
      seen.add(w);
      out.push(ft);
    }
  }
  // Longer, more field-specific tokens first (they carry more signal).
  return out.sort((a, b) => score(b) - score(a));
}

/** Classify one cleaned token; null when it is not a plausible code. */
function classifyToken(token: string): FieldToken | null {
  if (token.length < 4 || token.length > 40) return null;
  if (/^[A-Z]{2,}$/.test(token) && token.length <= 8) return null; // a word
  const digits = (token.match(/\d/g) || []).length;
  if (!/.*[0-9].*/.test(token)) return null; // pure letters: skip
  const digitRatio = digits / token.length;
  for (const rule of FIELD_RULES) {
    if (rule.test.test(token)) {
      return { token, field: rule.kind, formatScore: rule.formatScore };
    }
  }
  const base = fmtScore(token.length, digitRatio);
  // Hyphenated runs look like article/SKU refs.
  if (/^[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/.test(token)) {
    return { token, field: 'ARTICLE', formatScore: Math.min(1, base + 0.25) };
  }
  if (/^(?=[A-Z0-9]*\d)[A-Z0-9]{5,18}$/.test(token)) {
    return { token, field: 'ARTICLE', formatScore: base };
  }
  return null;
}

/** Prefer the fields relevant to the label kind when ranking candidates. */
export function scoreForLabel(ft: FieldToken, labelKind: LabelKind): number {
  const priority = PRIORITY[labelKind];
  const idx = priority.indexOf(ft.field);
  const fieldBoost = idx === -1 ? 0.1 : Math.max(0, 0.55 - idx * 0.14);
  return ft.formatScore + fieldBoost;
}

/** Order tokens for a label kind (best first). */
export function orderForLabel(tokens: FieldToken[], labelKind: LabelKind): FieldToken[] {
  return tokens.slice().sort((a, b) => scoreForLabel(b, labelKind) - scoreForLabel(a, labelKind));
}

function cleanToken(s: string): string | null {
  const t = s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
  return t || null;
}

function score(ft: FieldToken): number {
  return ft.formatScore;
}

/** Format plausibility of a normalised token for confidence (0..1). */
export function formatScoreForToken(token: string, labelKind: LabelKind): number {
  const t = token.replace(/[^A-Z0-9]/g, '');
  if (!t || t.length < 4) return 0;
  if (!/\d/.test(t)) return 0.15;
  const hit = orderForLabel(extractFieldTokens(token), labelKind)[0];
  return hit ? hit.formatScore : 0.6;
}
