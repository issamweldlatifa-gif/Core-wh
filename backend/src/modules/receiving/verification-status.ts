/**
 * ORDER 01 — verification status mapping layer (pure, dependency-free).
 *
 * The ORDER requires three SEPARATE status vocabularies:
 *   Task Status    : PENDING | IN_PROGRESS | VERIFIED | REPORT_SUBMITTED | COMPLETED
 *   Product Status : EXPECTED | SCANNED | CONFIRMED | MISSING | DAMAGED
 *   Report Status  : DRAFT | SUBMITTED | REVIEWED | CLOSED
 *
 * The existing enums (ReceivingProductStatus / AssignmentStatus) are shared
 * across stations, so they are NOT renamed. Instead:
 *   - Product verification (CONFIRMED/MISSING/DAMAGED/PENDING) is DERIVED
 *     from expected/received/damaged quantities;
 *   - Task verification status is DERIVED from (assignment/session/report);
 *   - Report status is STORED on the new ReceivingReport table.
 */

export type VerificationResult = 'PENDING' | 'CONFIRMED' | 'MISSING' | 'DAMAGED';
export type VerificationTaskStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'VERIFIED'
  | 'REPORT_SUBMITTED'
  | 'COMPLETED';
export type ReportStatusValue = 'DRAFT' | 'SUBMITTED' | 'REVIEWED' | 'CLOSED';

export interface LineVerification {
  scanned: number;
  confirmed: number;
  missing: number;
  damaged: number;
  result: VerificationResult;
}

/**
 * Per-product verification from the counted quantities.
 *
 * Definitions (ORDER 01 §5):
 *   scanned   = received (every physically scanned unit)
 *   damaged   = worker-declared damaged subset of scanned
 *   confirmed = scanned - damaged
 *   missing   = max(0, expected - scanned)
 *
 * Result priority: untouched -> PENDING; any damage -> DAMAGED;
 * short of expected -> MISSING; otherwise -> CONFIRMED (overage included,
 * the numbers expose it).
 */
export function computeLineVerification(input: {
  expected: number;
  received: number;
  damaged?: number | null;
}): LineVerification {
  const expected = Math.max(0, Math.floor(Number(input.expected) || 0));
  const received = Math.max(0, Math.floor(Number(input.received) || 0));
  const damaged = Math.min(received, Math.max(0, Math.floor(Number(input.damaged) || 0)));
  const scanned = received;
  const confirmed = Math.max(0, received - damaged);
  const missing = Math.max(0, expected - received);
  let result: VerificationResult = 'PENDING';
  if (received === 0 && damaged === 0) result = 'PENDING';
  else if (damaged > 0) result = 'DAMAGED';
  else if (received < expected) result = 'MISSING';
  else result = 'CONFIRMED';
  return { scanned, confirmed, missing, damaged, result };
}

/**
 * Receiving task verification status (ORDER 01 §9) derived from the
 * workflow position — the shared AssignmentStatus enum is left untouched.
 */
export function receivingTaskStatus(input: {
  hasSession: boolean;
  sessionStatus?: string | null;
  reportStatus?: ReportStatusValue | null;
}): VerificationTaskStatus {
  if (input.reportStatus === 'CLOSED') return 'COMPLETED';
  if (input.reportStatus === 'SUBMITTED' || input.reportStatus === 'REVIEWED') return 'REPORT_SUBMITTED';
  if (input.sessionStatus === 'COMPLETED' || input.sessionStatus === 'COMPLETED_WITH_DISCREPANCY') {
    return 'VERIFIED';
  }
  if (input.hasSession) return 'IN_PROGRESS';
  return 'PENDING';
}
