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

  it('SUBMITTED needs NO admin action — the submit auto-routes it to receiving (view/print/void only) — owner order 2026-09-13', () => {
    expect(batchActions('SUBMITTED', admin).sort()).toEqual(['delete', 'print', 'printBt', 'void']);
  });

  it('ACCEPTED offers NO send (transient: accept commits the automatic send) (+ print)', () => {
    expect(batchActions('ACCEPTED', admin).sort()).toEqual(['delete', 'print', 'printBt', 'void']);
  });

  it('RECEIVING_COMPLETED is terminal: print + hard delete (owner 2026-09-14) only', () => {
    expect(batchActions('RECEIVING_COMPLETED', admin)).toEqual(['print', 'printBt', 'delete']);
  });

  it('VOIDED is terminal too (print + hard delete per owner 2026-09-14)', () => {
    expect(batchActions('VOIDED', admin)).toEqual(['print', 'printBt', 'delete']);
  });

  it('permissions gate every action (viewer gets print only)', () => {
    expect(batchActions('SUBMITTED', viewer)).toEqual(['print', 'printBt']);
    // accept WITHOUT send/void permissions → no fused click (needs both),
    // no void — print only.
    expect(batchActions('ACCEPTED', acceptOnly).sort()).toEqual(['print', 'printBt']);
    expect(batchActions('SUBMITTED', acceptOnly)).toEqual(['print', 'printBt']); // no void perm → print only
  });

  it('an unknown status degrades to print + hard delete — no invented offers', () => {
    expect(batchActions('SOMETHING_ELSE', admin)).toEqual(['print', 'printBt', 'delete']);
  });

  it('every non-terminal state offers void (VOID ≠ the owner-ordered hard delete)', () => {
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
