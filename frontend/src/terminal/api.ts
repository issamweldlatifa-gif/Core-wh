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
  relatedType: string | null;
  relatedCode: string | null;
  status: string;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const terminalApi = {
  context: () => client.get<TerminalContext>('/v1/terminal/context').then((r) => r.data),
  // COMMAND #3 — my assigned tasks (an admin attached them to this worker).
  assignments: () =>
    client.get<{ open: TerminalAssignment[]; recent: TerminalAssignment[] }>('/v1/terminal/assignments').then((r) => r.data),
  completeAssignment: (id: string) =>
    client.post(`/v1/terminal/assignments/${id}/complete`, {}).then((r) => r.data),
};

/** Does the worker's station advertise a capability? (§10/§11) */
export function stationHas(station: TerminalStation | null, cap: string): boolean {
  // With no station configured we do not disable functionality — a worker on
  // an unregistered device must still be able to work (the backend remains
  // the authority on what they may DO).
  if (!station) return true;
  return station.capabilities.includes(cap);
}
