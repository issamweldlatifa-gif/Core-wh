import client from '../api/client';

/**
 * AYROVI BATCH — Admin API surface + pure UI rules (Phase 2).
 *
 * The admin drives the batch card lifecycle: review (needsReview badge on
 * worker-created customers) → ACCEPT → SEND to receiving — plus VOID+reason
 * and the printable label. All calls hit the isolated /batches controller
 * (never the CRM/Arrival endpoints); the backend re-checks permissions, the
 * `batch.enabled` flag, the state machine and idempotency — this client is
 * convenience only, never the source of truth.
 */

export interface BatchCustomerLight {
  id: string;
  name: string;
  externalRef: string | null;
  needsReview: boolean;
}

export interface BatchRow {
  id: string;
  batchCode: string;
  status: string;
  totalExpected: number;
  totalScanned: number;
  customer: BatchCustomerLight | null;
  createdAt: string;
  submittedAt: string | null;
  acceptedAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  _count?: { items: number };
}

export interface BatchUnitRow {
  code: string;
  originalBarcode: string | null;
  originalSku: string | null;
  originalReference: string | null;
}

export interface BatchItemRow {
  id: string;
  status: string;
  identifierType: string;
  identifierValue: string | null;
  unit: BatchUnitRow;
}

export interface BatchDetail extends BatchRow {
  items: BatchItemRow[];
}

/** Status → existing os-tag variant (house vocabulary, no new CSS). */
export const BATCH_STATUS_TAG: Record<string, string> = {
  CREATED: 'os-tag--muted',
  SUBMITTED: 'os-tag--warn',
  ACCEPTED: 'os-tag--warn',
  SENT_TO_RECEIVING: 'os-tag--info',
  RECEIVING_IN_PROGRESS: 'os-tag--info',
  RECEIVING_COMPLETED: 'os-tag--ok',
  VOIDED: 'os-tag--err',
};

/** Terminal batch states: no further decision (void included) is offered. */
export const BATCH_TERMINAL_STATES = ['RECEIVING_COMPLETED', 'VOIDED'];

/**
 * States the backend state machine knows and from which `void` is a legal
 * transition. Mirrors batch-status.ts EXACTLY: an unknown status must never
 * be offered any decision (print only) — same answer as the server's 409.
 */
export const BATCH_VOIDABLE_STATES = [
  'CREATED',
  'SUBMITTED',
  'ACCEPTED',
  'SENT_TO_RECEIVING',
  'RECEIVING_IN_PROGRESS',
];

export type BatchUiAction = 'accept-send' | 'send' | 'void' | 'print';

/**
 * Pure rule: which actions a given batch card offers, from the STATUS ×
 * PERMISSIONS matrix. Mirrors the backend state machine exactly (unknown
 * state ⇒ print only; terminals ⇒ print only).
 */
export function batchActions(status: string, has: (perm: string) => boolean): BatchUiAction[] {
  const out: BatchUiAction[] = [];
  if (has('batch.view')) out.push('print');
  // OWNER DECISION (2026-09-12): admin -> receiving is AUTOMATIC — reviewing
  // a SUBMITTED batch fuses accept+send into ONE click (both endpoints are
  // still called, so the audit trail keeps both transitions).
  if (status === 'SUBMITTED' && has('batch.accept') && has('batch.send')) out.push('accept-send');
  if (status === 'ACCEPTED' && has('batch.send')) out.push('send');
  if (BATCH_VOIDABLE_STATES.includes(status) && has('batch.void')) out.push('void');
  return out;
}

/**
 * Fresh key per send click. The BACKEND stores it at the transition and
 * replays it — the client only has to never send the same op twice with the
 * same key on purpose.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `admin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const batchesAdminApi = {
  list: (status?: string) =>
    client
      .get('/v1/batches', { params: status ? { status } : undefined })
      .then((r) => r.data as BatchRow[]),

  get: (id: string) =>
    client.get(`/v1/batches/${id}`).then((r) => r.data as BatchDetail),

  accept: (id: string, operatorId: string) =>
    client.post(`/v1/batches/${id}/accept`, { operatorId }).then((r) => r.data),

  send: (id: string, operatorId: string) =>
    client
      .post(`/v1/batches/${id}/send`, { operatorId, idempotencyKey: newIdempotencyKey() })
      .then((r) => r.data),

  voidBatch: (id: string, operatorId: string, reason: string) =>
    client.post(`/v1/batches/${id}/void`, { operatorId, reason }).then((r) => r.data),
};
