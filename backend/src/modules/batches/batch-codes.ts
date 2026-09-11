/**
 * BATCH / UNIT CODE GENERATORS — deterministic, collision-walking, pure.
 *
 * Batch:   AYB-YYYYMMDD-NNNNN   (group identity; tests: AYBTEST-…)
 * Unit:    AYP-NNNNNNNNN        (piece identity;  tests: AYPTEST-…)
 *
 * Sequencing follows the existing WAR- pattern: derive the next number from
 * the HIGHEST existing code (never count()), then walk forward past any
 * collision. The future service passes the codes already in the database;
 * these functions stay I/O-free and fully testable.
 */
export const BATCH_CODE_PREFIX = 'AYB-';
export const BATCH_TEST_PREFIX = 'AYBTEST-';
export const UNIT_CODE_PREFIX = 'AYP-';
export const UNIT_TEST_PREFIX = 'AYPTEST-';

export const BATCH_CODE_RE = /^AYB(TEST)?-\d{8}-\d{5}$/;
export const UNIT_CODE_RE = /^AYP(TEST)?-\d{9}$/;

function maxSeq(codes: string[], prefix: string, tailDigits: number): number {
  let max = Number.NaN;
  for (const c of codes) {
    if (!c.startsWith(prefix)) continue;
    const tail = c.slice(prefix.length).replace(/\D/g, '');
    if (tail.length !== tailDigits) continue;
    const n = Number.parseInt(tail, 10);
    if (Number.isFinite(n) && (Number.isNaN(max) || n > max)) max = n;
  }
  return max;
}

function walk(start: number, taken: Set<string>, render: (n: number) => string, attempts = 64): string {
  for (let n = start; n < start + attempts; n += 1) {
    const code = render(n);
    if (!taken.has(code)) return code;
  }
  // Fallback mirroring the WAR- pattern: time-unique tail if heavily contended.
  return render(start) + Date.now().toString(36).toUpperCase();
}

/** Next batch code: `AYB-YYYYMMDD-NNNNN` (or AYBTEST-…) for `todayIso` (YYYY-MM-DD). */
export function nextBatchCode(todayIso: string, existingCodes: string[], test = false): string {
  const prefix = test ? BATCH_TEST_PREFIX : BATCH_CODE_PREFIX;
  const day = todayIso.replaceAll('-', '');
  if (!/^\d{8}$/.test(day)) throw new Error('todayIso must be YYYY-MM-DD');
  const scoped = existingCodes.filter((c) => c.startsWith(`${prefix}${day}-`));
  const taken = new Set(existingCodes);
  const last = maxSeq(scoped, `${prefix}${day}-`, 5);
  const start = Number.isFinite(last) ? last + 1 : 1;
  return walk(start, taken, (n) => `${prefix}${day}-${String(n).padStart(5, '0')}`);
}

/** Next unit identity: `AYP-NNNNNNNNN` (or AYPTEST-…) — global sequence. */
export function nextUnitCode(existingCodes: string[], test = false): string {
  const prefix = test ? UNIT_TEST_PREFIX : UNIT_CODE_PREFIX;
  const digits = 9;
  const taken = new Set(existingCodes);
  const last = maxSeq(existingCodes, prefix, digits);
  const start = Number.isFinite(last) ? last + 1 : 1;
  return walk(start, taken, (n) => `${prefix}${String(n).padStart(digits, '0')}`);
}
