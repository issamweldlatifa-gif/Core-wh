/**
 * OCR normalisation & confusion model — order §9.
 *
 * OCR confuses glyphs that look alike (O↔0, I↔1, S↔5, B↔8, G↔6 …). We expose:
 *
 *   1. `normaliseToken` — deterministic cleanup (case, separators, noise).
 *   2. a symmetric confusable table + `confusableAliases(ch)`.
 *   3. `ocrEditDistance(a, b)` — edit distance where substituting a confusable
 *      glyph pair costs `confusableCost` (< 1) instead of a full substitution.
 *
 * Design rule (order §9): substitutions are NEVER applied blindly to the
 * output. They only make the *distance* to a real AYROVI record cheap, so a
 * corpus match decides whether «ABCI2345» really means «ABC12345» — never the
 * OCR token on its own.
 */

/** Canonical character set after cleanup. */
export const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

/** Symmetric confusable glyph classes observed in label OCR. */
const CONFUSABLE_CLASSES: string[] = [
  'O0Q', // O / zero / Q
  'I1l', // I / one / lower-L
  'S5', // S / five
  'B8', // B / eight
  'G6', // G / six
  'Z2', // Z / two
  'D0', // D / zero (visual) — D also vs O handled above
];

const ALIASES = new Map<string, string[]>();
function buildAliases() {
  for (const cls of CONFUSABLE_CLASSES) {
    for (const ch of cls) {
      const others = cls.split('').filter((c) => c !== ch);
      const list = ALIASES.get(ch) ?? [];
      list.push(...others);
      ALIASES.set(ch, list);
    }
  }
  // Upper-case "l" handled above; explicit digit/letter common swaps.
  const extra: Record<string, string[]> = { '0': ['D', 'O'], O: ['0', 'D', 'Q'], D: ['0', 'O'] };
  for (const [ch, xs] of Object.entries(extra)) {
    const list = ALIASES.get(ch) ?? [];
    for (const x of xs) if (!list.includes(x)) list.push(x);
    ALIASES.set(ch, list);
  }
}
buildAliases();

/** Glyphs OCR may confuse `ch` with (excluding ch itself). */
export function confusableAliases(ch: string): string[] {
  return ALIASES.get(ch) ?? [];
}

/** Deterministic cleanup of a raw OCR token. */
export function normaliseToken(raw: string): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .replace(/[|_]/g, ' ')
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/\s+/g, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * Edit distance where a confusable substitution costs `confusableCost`
 * (default 0.5) and a normal substitution costs 1; insert/delete cost 1.
 * Lower = closer. A token whose every difference is a known OCR confusion is
 * therefore very close to the real record WITHOUT guessing its meaning.
 */
export function ocrEditDistance(
  a: string,
  b: string,
  confusableCost = 0.5,
): number {
  const A = a.toUpperCase();
  const B = b.toUpperCase();
  if (A === B) return 0;
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  const m = A.length;
  const n = B.length;
  if (Math.abs(m - n) > 2) return Math.max(m, n); // cheap early bail (length gate elsewhere)
  const prev = new Float64Array(n + 1);
  const cur = new Float64Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const ac = A[i - 1];
      const bc = B[j - 1];
      const subCost = ac === bc ? 0 : confusableAliases(ac).includes(bc) ? confusableCost : 1;
      const del = prev[j] + 1; // a[i] deleted
      const ins = cur[j - 1] + 1; // b[j] inserted
      const sub = prev[j - 1] + subCost;
      cur[j] = Math.min(del, ins, sub);
    }
    prev.set(cur);
  }
  return prev[n];
}

/** Is `token` already clean & plausible length for a code? */
export function isPlausibleToken(token: string, min = 4, max = 40): boolean {
  const t = normaliseToken(token);
  return t.length >= min && t.length <= max && /\d/.test(t);
}
