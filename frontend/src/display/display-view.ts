/**
 * Station Display view model (owner order 2026-09-16) — pure, testable.
 * The display page is READ-ONLY: it renders the same transactions the CT40
 * wrote (same ids), never creates anything.
 */

export interface DisplaySnapshot {
  enabled?: boolean;
  display?: { name: string; type?: string };
  station?: { code: string; name: string; department: string; status: string } | null;
  worker?: { code: string; name: string } | null;
  operation?: { label: string; sessionCode?: string | null; sessionStatus?: string | null; arrivalReference?: string | null } | null;
  task?: { title: string; status: string } | null;
  lastScan?: {
    id: string;
    kind: string;
    code?: string | null;
    productName?: string | null;
    customerName?: string | null;
    quantity?: number | null;
    status?: string | null;
    at: string;
  } | null;
  error?: { type: string; reason?: string | null; at: string } | null;
  customer?: string | null;
  progress?: { done: number; total: number; label?: string } | null;
  lastUpdate: string;
}

/** §11 display states. */
export type DisplayState = 'DISABLED' | 'IDLE' | 'PROCESSING' | 'SUCCESS' | 'ERROR';

/** How long a recent scan keeps the SUCCESS state on screen. */
export const SUCCESS_WINDOW_MS = 120_000;

export function viewState(snap: DisplaySnapshot | null, now = Date.now()): DisplayState {
  if (!snap || snap.enabled === false) return 'DISABLED';
  if (snap.error) return 'ERROR';
  const at = snap.lastScan ? +new Date(snap.lastScan.at) : 0;
  if (snap.lastScan && now - at < SUCCESS_WINDOW_MS) return 'SUCCESS';
  if (snap.operation) return 'PROCESSING';
  return 'IDLE';
}

/** §13 Connected/Offline — the same 90s bound the backend uses. */
export const DISPLAY_OFFLINE_AFTER_MS = 90_000;

export function isDisplayOnline(lastSeenAt: string | Date | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false;
  return now - +new Date(lastSeenAt) < DISPLAY_OFFLINE_AFTER_MS;
}

/** "just now" / "42s ago" / "3m ago" for the Last update line. */
export function relativeTime(ts: string | Date | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const d = +new Date(ts);
  if (!Number.isFinite(d)) return '—';
  const s = Math.max(0, Math.round((now - d) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** The admin-side URL for a display (same origin — any browser screen). */
export function displayUrl(token: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  return `${origin}/display/${token}`;
}
