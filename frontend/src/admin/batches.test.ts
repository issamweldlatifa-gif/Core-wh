import { describe, expect, it } from 'vitest';
import { BATCH_VOIDABLE_STATES, batchActions, newIdempotencyKey } from './batches';

/**
 * BATCH admin board — pure UI rules. The button matrix must mirror the
 * backend state machine EXACTLY (an offered-but-forbidden action would only
 * produce a confusing 409; a missing offer would block the lifecycle).
 */
describe('batchActions — status × permission matrix', () => {
  const admin = (p: string) => ['batch.view', 'batch.accept', 'batch.send', 'batch.void'].includes(p);
  const viewer = (p: string) => p === 'batch.view';
  const acceptOnly = (p: string) => p === 'batch.view' || p === 'batch.accept';

  it('SUBMITTED offers the FUSED accept-send (+ print) — owner decision 2026-09-12', () => {
    expect(batchActions('SUBMITTED', admin).sort()).toEqual(['accept-send', 'print', 'void']);
  });

  it('ACCEPTED offers the plain send (recovery path) (+ print)', () => {
    expect(batchActions('ACCEPTED', admin).sort()).toEqual(['print', 'send', 'void']);
  });

  it('RECEIVING_COMPLETED is terminal: print only, even for the admin', () => {
    expect(batchActions('RECEIVING_COMPLETED', admin)).toEqual(['print']);
  });

  it('VOIDED is terminal too', () => {
    expect(batchActions('VOIDED', admin)).toEqual(['print']);
  });

  it('permissions gate every action (viewer gets print only)', () => {
    expect(batchActions('SUBMITTED', viewer)).toEqual(['print']);
    // accept WITHOUT send/void permissions → no fused click (needs both),
    // no void — print only.
    expect(batchActions('ACCEPTED', acceptOnly).sort()).toEqual(['print']);
    expect(batchActions('SUBMITTED', acceptOnly)).toEqual(['print']);
  });

  it('an unknown status degrades to print only — no invented offers', () => {
    expect(batchActions('SOMETHING_ELSE', admin)).toEqual(['print']);
  });

  it('every non-terminal state offers void (no real DELETE exists)', () => {
    for (const s of ['CREATED', 'SUBMITTED', 'ACCEPTED', 'SENT_TO_RECEIVING', 'RECEIVING_IN_PROGRESS']) {
      expect(batchActions(s, admin)).toContain('void');
      expect(BATCH_VOIDABLE_STATES).toContain(s);
    }
  });
});

describe('newIdempotencyKey — fresh per op', () => {
  it('never repeats within a session', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(seen.size).toBe(200);
  });

  it('produces non-empty strings of a sane length', () => {
    const k = newIdempotencyKey();
    expect(k.length).toBeGreaterThanOrEqual(8);
    expect(k.length).toBeLessThanOrEqual(64);
  });
});
