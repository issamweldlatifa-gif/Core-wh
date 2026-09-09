import { computeLineVerification, receivingTaskStatus } from './verification-status';

/** ORDER 01 — verification mapping layer (pure unit tests, no DB). */
describe('computeLineVerification', () => {
  it('untouched line -> PENDING with full missing', () => {
    expect(computeLineVerification({ expected: 10, received: 0 })).toEqual({
      scanned: 0, confirmed: 0, missing: 10, damaged: 0, result: 'PENDING',
    });
  });
  it('fully scanned, no damage -> CONFIRMED', () => {
    expect(computeLineVerification({ expected: 10, received: 10 })).toEqual({
      scanned: 10, confirmed: 10, missing: 0, damaged: 0, result: 'CONFIRMED',
    });
  });
  it('partial scan -> MISSING with remaining count', () => {
    expect(computeLineVerification({ expected: 10, received: 6 })).toEqual({
      scanned: 6, confirmed: 6, missing: 4, damaged: 0, result: 'MISSING',
    });
  });
  it('any damage -> DAMAGED and confirmed excludes damaged', () => {
    expect(computeLineVerification({ expected: 10, received: 10, damaged: 3 })).toEqual({
      scanned: 10, confirmed: 7, missing: 0, damaged: 3, result: 'DAMAGED',
    });
  });
  it('damage wins over missing', () => {
    expect(computeLineVerification({ expected: 10, received: 6, damaged: 1 }).result).toBe('DAMAGED');
  });
  it('damage is capped to scanned (never negative confirmed)', () => {
    expect(computeLineVerification({ expected: 10, received: 4, damaged: 99 })).toEqual({
      scanned: 4, confirmed: 0, missing: 6, damaged: 4, result: 'DAMAGED',
    });
  });
  it('overage -> CONFIRMED (numbers expose the surplus)', () => {
    const v = computeLineVerification({ expected: 10, received: 12 });
    expect(v.result).toBe('CONFIRMED');
    expect(v.scanned).toBe(12);
    expect(v.missing).toBe(0);
  });
});

describe('receivingTaskStatus', () => {
  it('no session -> PENDING', () => {
    expect(receivingTaskStatus({ hasSession: false })).toBe('PENDING');
  });
  it('open session -> IN_PROGRESS', () => {
    expect(receivingTaskStatus({ hasSession: true, sessionStatus: 'RECEIVING' })).toBe('IN_PROGRESS');
    expect(receivingTaskStatus({ hasSession: true, sessionStatus: 'PAUSED' })).toBe('IN_PROGRESS');
  });
  it('closed session without report -> VERIFIED', () => {
    expect(receivingTaskStatus({ hasSession: true, sessionStatus: 'COMPLETED' })).toBe('VERIFIED');
    expect(receivingTaskStatus({ hasSession: true, sessionStatus: 'COMPLETED_WITH_DISCREPANCY' })).toBe(
      'VERIFIED',
    );
  });
  it('submitted/reviewed report -> REPORT_SUBMITTED', () => {
    expect(
      receivingTaskStatus({ hasSession: true, sessionStatus: 'COMPLETED', reportStatus: 'SUBMITTED' }),
    ).toBe('REPORT_SUBMITTED');
    expect(
      receivingTaskStatus({ hasSession: true, sessionStatus: 'RECEIVING', reportStatus: 'REVIEWED' }),
    ).toBe('REPORT_SUBMITTED');
  });
  it('closed report -> COMPLETED', () => {
    expect(
      receivingTaskStatus({ hasSession: true, sessionStatus: 'COMPLETED', reportStatus: 'CLOSED' }),
    ).toBe('COMPLETED');
  });
});
