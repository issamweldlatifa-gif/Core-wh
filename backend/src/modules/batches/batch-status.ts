/**
 * BATCH LIFECYCLE — the single server-side state machine (Phase 2 contract).
 *
 * CREATED -> SUBMITTED -> ACCEPTED -> SENT_TO_RECEIVING
 *         -> RECEIVING_IN_PROGRESS -> RECEIVING_COMPLETED
 * any non-terminal state -> VOIDED (never a real delete).
 *
 * Every unlisted transition is REJECTED. The device renders the state; it
 * never owns it. Pure functions only — no framework, fully table-tested.
 */
export const BATCH_STATUSES = [
  'CREATED',
  'SUBMITTED',
  'ACCEPTED',
  'SENT_TO_RECEIVING',
  'RECEIVING_IN_PROGRESS',
  'RECEIVING_COMPLETED',
  'VOIDED',
] as const;

export type BatchStatusValue = (typeof BATCH_STATUSES)[number];

export type BatchAction =
  | 'submit'
  | 'accept'
  | 'send'
  | 'startReceiving'
  | 'completeReceiving'
  | 'void';

const TRANSITIONS: Record<BatchStatusValue, Partial<Record<BatchAction, BatchStatusValue>>> = {
  CREATED: { submit: 'SUBMITTED', void: 'VOIDED' },
  SUBMITTED: { accept: 'ACCEPTED', void: 'VOIDED' },
  ACCEPTED: { send: 'SENT_TO_RECEIVING', void: 'VOIDED' },
  SENT_TO_RECEIVING: { startReceiving: 'RECEIVING_IN_PROGRESS', void: 'VOIDED' },
  RECEIVING_IN_PROGRESS: { completeReceiving: 'RECEIVING_COMPLETED', void: 'VOIDED' },
  RECEIVING_COMPLETED: {}, // terminal
  VOIDED: {}, // terminal
};

/** Next status for (from, action), or null when the transition is forbidden. */
export function nextBatchStatus(from: BatchStatusValue, action: BatchAction): BatchStatusValue | null {
  return TRANSITIONS[from]?.[action] ?? null;
}

/** Throwing variant with an explicit, worker-translatable reason. */
export function assertBatchTransition(from: BatchStatusValue, action: BatchAction): BatchStatusValue {
  const to = nextBatchStatus(from, action);
  if (to === null) {
    throw new Error(`FORBIDDEN_BATCH_TRANSITION: ${action} is not allowed from ${from}`);
  }
  return to;
}
