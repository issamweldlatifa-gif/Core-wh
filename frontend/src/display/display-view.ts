/**
 * Station Display view model (owner order 2026-09-16; stage 2 the same day).
 * The display page is a live view of the same transactions the CT40 wrote
 * (same ids) — and, when the owner enabled it on that display, a CONTROL
 * SURFACE for the station: print / reprint, acknowledge, help, exception.
 * Everything here is pure and testable; the component only renders it.
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
  recent?: Array<{
    id: string; kind: string; code?: string | null; productName?: string | null;
    customerName?: string | null; quantity?: number | null; status?: string | null; at: string;
  }>;
  /** Stage 2 — what this screen is allowed to do (server-side truth). */
  options?: {
    interactive?: boolean;
    sound?: boolean;
    printTransport?: 'BROWSER' | 'BRIDGE' | 'CT40';
    actions?: DisplayAction[];
  };
  /** Stage 2 — operator → station messages awaiting an acknowledgement. */
  messages?: DisplayMessage[];
  lastUpdate: string;
}

export type DisplayAction = 'print' | 'reprint' | 'ack' | 'help' | 'exception' | 'message' | 'move';

export interface DisplayMessage {
  id: string;
  body: string;
  severity: string;
  requireAck: boolean;
  at: string;
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

// ------------------------------------------------------------------
// STAGE 2 — the action bar.
// ------------------------------------------------------------------

/**
 * The actions the screen shows. Server truth first (`options.actions`), and
 * `reprint` additionally needs something to reprint — a screen with no
 * printable card must not offer a dead button.
 */
export function availableActions(
  snap: DisplaySnapshot | null,
  ctx: { hasPrintable: boolean; hasReprintable: boolean },
): DisplayAction[] {
  const allowed = snap?.options?.actions ?? [];
  if (snap?.options?.interactive !== true) return [];
  return (['print', 'reprint', 'ack', 'help', 'exception'] as DisplayAction[]).filter((a) => {
    if (!allowed.includes(a)) return false;
    if (a === 'print') return ctx.hasPrintable;
    if (a === 'reprint') return ctx.hasReprintable;
    return true;
  });
}

export const ACTION_LABELS: Record<DisplayAction, string> = {
  print: '🖨 PRINT LABEL',
  reprint: '🔁 REPRINT',
  ack: '✓ ACK ALERT',
  help: '🙋 CALL SUPERVISOR',
  exception: '⚠ REPORT PROBLEM',
  message: 'MESSAGE',
  move: 'MOVE',
};

/** Reasons offered as one-tap chips when the operator reports a problem. */
export const EXCEPTION_REASONS: Array<{ type: string; label: string }> = [
  { type: 'DAMAGED', label: 'Damaged' },
  { type: 'MISSING_PRODUCT', label: 'Missing' },
  { type: 'WRONG_PRODUCT', label: 'Wrong product' },
  { type: 'BLOCKED', label: 'Blocked' },
  { type: 'OTHER', label: 'Other' },
];

export const MESSAGE_STYLE: Record<string, { bg: string; border: string; color: string }> = {
  INFO: { bg: 'rgba(77,163,255,.14)', border: '#4da3ff66', color: '#cfe3f5' },
  WARNING: { bg: 'rgba(255,157,0,.16)', border: '#ff9d0066', color: '#ffd79a' },
  URGENT: { bg: 'rgba(255,93,93,.18)', border: '#ff5d5d88', color: '#ffc9c9' },
};

/** The message the screen must show now: highest severity, then oldest. */
export function topMessage(snap: DisplaySnapshot | null): DisplayMessage | null {
  const list = snap?.messages ?? [];
  if (list.length === 0) return null;
  const rank = (s: string) => (s === 'URGENT' ? 3 : s === 'WARNING' ? 2 : 1);
  return [...list].sort((a, b) => rank(b.severity) - rank(a.severity) || +new Date(a.at) - +new Date(b.at))[0];
}

/** True when the snapshot brings something worth a beep (scan, alert, message). */
export function soundCueFor(
  snap: DisplaySnapshot | null,
  prev: { lastScanId: string | null; errorType: string | null; messageId: string | null },
): 'SCAN_OK' | 'ERROR' | 'MESSAGE' | null {
  if (!snap || snap.enabled === false) return null;
  const msg = topMessage(snap);
  if (msg && msg.id !== prev.messageId) return 'MESSAGE';
  if (snap.error && snap.error.type !== prev.errorType) return 'ERROR';
  const id = snap.lastScan?.id ?? null;
  if (id && id !== prev.lastScanId) {
    const ok = !snap.error;
    return ok ? 'SCAN_OK' : 'ERROR';
  }
  return null;
}
