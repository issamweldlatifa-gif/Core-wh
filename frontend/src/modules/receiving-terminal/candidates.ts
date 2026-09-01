/**
 * Candidate extraction & stabilisation for OCR reads (spec §21/§23).
 *
 * Design rules taken straight from the spec:
 *   - Do NOT assume one universal SKU format (§21). The regex below is only a
 *     *candidate filter* used to pull plausible tokens out of noisy OCR text.
 *     It is never treated as the definition of a valid SKU — the backend, and
 *     the Expected Arrival data, decide what is real (§22/§25).
 *   - A weak single-frame read is never trusted (§23). A candidate must be
 *     seen consistently across several frames before it is submitted.
 */

/** Generic candidate shapes, ordered widest-first. */
const CANDIDATE_PATTERNS: RegExp[] = [
  // long alphanumeric run, e.g. sb25092090066487374
  /\b[A-Z0-9]{12,24}\b/g,
  // hyphenated reference, e.g. SKU-100200300 / ABC-1234-99
  /\b[A-Z0-9]{2,10}(?:-[A-Z0-9]{2,10}){1,3}\b/g,
  // medium alphanumeric with at least one digit, e.g. AB12345678
  /\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,14}\b/g,
];

/** Words OCR commonly lifts off shipping labels that are never SKUs. */
const STOPWORDS = new Set([
  'MADEIN', 'MADE', 'CHINA', 'ITALY', 'FRANCE', 'TUNISIA', 'TURKEY',
  'QTY', 'PCS', 'SIZE', 'COLOR', 'COLOUR', 'WEIGHT', 'NET', 'GROSS',
  'CARTON', 'BOX', 'TOTAL', 'FRAGILE', 'THIS', 'SIDE', 'WITH', 'CARE',
  'INVOICE', 'ORDER', 'DATE', 'FROM', 'SHIP', 'TRACKING', 'BARCODE',
]);

/**
 * OCR confusion repairs. Applied only to tokens, never to the raw frame, and
 * only where the surrounding characters make the substitution unambiguous.
 */
export function normaliseToken(raw: string): string {
  return (raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

/** Pull plausible SKU/reference candidates out of a block of OCR text. */
export function extractCandidates(text: string): string[] {
  if (!text) return [];
  const cleaned = text.toUpperCase().replace(/[|_]/g, ' ').replace(/\s+/g, ' ');
  const found: string[] = [];

  for (const re of CANDIDATE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of cleaned.matchAll(re)) {
      const token = normaliseToken(m[0]);
      if (token.length < 6) continue;
      if (STOPWORDS.has(token)) continue;
      // A pure alphabetic run is almost always a word, not a reference.
      if (!/\d/.test(token)) continue;
      if (!found.includes(token)) found.push(token);
    }
  }
  // Longer tokens first: they carry more signal and are less likely to be a
  // fragment of a larger reference.
  return found.sort((a, b) => b.length - a.length);
}

/**
 * Multi-frame stabiliser (§23).
 *
 * Records candidates frame by frame and only reports one as STABLE once it
 * has been seen `threshold` times inside the sliding window. Thresholds are
 * configurable because they must be tuned against real labels (§23).
 */
export class CandidateStabiliser {
  private readonly hits = new Map<string, number>();
  private frames = 0;

  constructor(
    private readonly threshold = 3,
    private readonly windowFrames = 12,
  ) {}

  /** Feed one frame's candidates; returns a stable candidate or null. */
  push(candidates: string[]): string | null {
    this.frames += 1;
    for (const c of candidates) {
      this.hits.set(c, (this.hits.get(c) ?? 0) + 1);
    }

    let best: string | null = null;
    let bestCount = 0;
    for (const [token, count] of this.hits) {
      if (count > bestCount) {
        best = token;
        bestCount = count;
      }
    }

    if (best && bestCount >= this.threshold) {
      this.reset();
      return best;
    }

    // Slide the window so a candidate seen once long ago cannot accumulate
    // across an unbounded period and produce a false "stable" read.
    if (this.frames >= this.windowFrames) this.reset();
    return null;
  }

  reset(): void {
    this.hits.clear();
    this.frames = 0;
  }
}
