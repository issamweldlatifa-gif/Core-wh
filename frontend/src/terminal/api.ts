import client from '../api/client';

/**
 * Worker Terminal API surface.
 *
 * The terminal asks the backend what the worker may do rather than deciding
 * locally (§2/§9): the frontend only renders what the server authorises.
 */

export interface TerminalTask {
  key: string;
  label: string;
  path: string;
  department: string;
  permission: string;
  ready: boolean;
  /** Worker-visible sub-action sharing the parent's route (e.g. tote filling). */
  subtaskOf?: string | null;
  /** Reference workflow: the OPERATION this lane executes (Admin/terminal display). */
  operation?: string | null;
  /** Reference workflow: the WORK executed inside that operation. */
  work?: string | null;
}

export interface TerminalStation {
  id: string;
  code: string;
  name: string;
  department: string;
  capabilities: string[];
}

export interface TerminalContext {
  worker: { id: string };
  tasks: TerminalTask[];
  readyTaskCount: number;
  /** Where the shell should land this worker (§3). */
  home: string;
  station: TerminalStation | null;
  activeSession: {
    id: string;
    code: string;
    status: string;
    startedAt: string;
    expectedArrival: { id: string; code: string; customerName: string } | null;
  } | null;
  /** An open stowing session, so a refresh mid-putaway is not lost. */
  activePutaway: {
    id: string;
    code: string;
    status: string;
    startedAt: string;
  } | null;
  /** Whichever work is genuinely open — drives resume routing (§3). */
  resume: {
    kind: 'RECEIVING' | 'PUTAWAY';
    path: string;
    code: string;
    startedAt: string;
  } | null;
}

export interface TerminalAssignment {
  id: string;
  title: string;
  description: string | null;
  taskKey: string | null;
  relatedType: string | null;
  relatedCode: string | null;
  status: string;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  entity?: {
    arrival: { id: string; code: string; status: string } | null;
    carton: { id: string; code: string; status: string } | null;
    container: { id: string; code: string; status: string; type: string } | null;
    outbound: { id: string; code: string; status: string } | null;
    order: { id: string; code: string; status: string } | null;
  } | null;
  station?: { id: string; code: string; name: string } | null;
}

/** Work availability counters per task (backend truth only, §34). */
export interface WorkCount {
  key: string;
  label: string;
  path: string;
  department: string;
  /** Assignments addressed to ME for this task. */
  assigned: number;
  /** Work available on the floor (real database counts). */
  available: number;
  /** Work already started/claimed by me (sessions, claims). */
  mine: number;
}

export const WORKER_ISSUE_TYPES = [
  'SHORTAGE',
  'OVERAGE',
  'UNKNOWN_CARTON',
  'WRONG_SHIPMENT',
  'UNEXPECTED_PRODUCT',
  'MISSING_PRODUCT',
  'MISSING_CARTON',
  'IDENTIFICATION_ERROR',
  'OTHER',
] as const;

export const terminalApi = {
  context: () => client.get<TerminalContext>('/v1/terminal/context').then((r) => r.data),
  // COMMAND #3 — my assigned tasks (an admin attached them to this worker).
  assignments: () =>
    client.get<{ open: TerminalAssignment[]; recent: TerminalAssignment[] }>('/v1/terminal/assignments').then((r) => r.data),
  completeAssignment: (id: string, note?: string) =>
    client.post(`/v1/terminal/assignments/${id}/complete`, { note }).then((r) => r.data),
  /** Live work counters for the Worker Home (§34). */
  work: () => client.get<WorkCount[]>('/v1/terminal/work').then((r) => r.data),
  /** REPORT ISSUE from any operational screen (§41 / C-16). */
  reportIssue: (d: { type: string; description: string; taskKey?: string; sessionId?: string; entityCode?: string }) =>
    client.post<{ ok: true; discrepancyId: string | null }>('/v1/terminal/issues', d).then((r) => r.data),
};

/** Does the worker's station advertise a capability? (§10/§11) */
export function stationHas(station: TerminalStation | null, cap: string): boolean {
  // With no station configured we do not disable functionality — a worker on
  // an unregistered device must still be able to work (the backend remains
  // the authority on what they may DO).
  if (!station) return true;
  return station.capabilities.includes(cap);
}
