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
  operation?: {
    label: string;
    sessionCode?: string | null;
    sessionStatus?: string | null;
    arrivalReference?: string | null;
    /** When the running operation started (handover context). */
    startedAt?: string | null;
  } | null;
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
    /** v3 SCREEN ROLE — the server also already filtered the payload for it. */
    view?: DisplayView;
  };
  /** v3 ANDON — the line colour (code + age only, no free text). */
  andon?: { state: AndonState; code: string; since?: string | null } | null;
  /** Stage 2 — operator → station messages awaiting an acknowledgement. */
  messages?: DisplayMessage[];
  // ---- ASSIST LAYER (owner order 2026-09-16: show EVERYTHING about the
  // station and help the worker). Computed server-side, never by the browser. */
  /** The next step, in plain words. */
  guidance?: DisplayGuidance | null;
  /** Why the station is not moving (only when the next step is a wait). */
  waiting?: { reason: string; since?: string | null } | null;
  /** What is still expected next (biggest gap first). */
  queue?: DisplayQueueItem[];
  /** Everything wrong or unanswered at this station right now. */
  alerts?: DisplayAlert[];
  /** Today's totals for this station. */
  stats?: DisplayStats | null;
  /** A supervisor call from this screen that nobody confirmed yet. */
  help?: { open: boolean; at?: string | null } | null;
  lastUpdate: string;
}

/**
 * SCREEN FIT (owner report 2026-09-16: «half the page is not visible and the
 * buttons never show»). Every size on a station screen is expressed in ONE
 * unit that tracks the viewport, so the same screen is complete on a 24" TV,
 * on a laptop at 1366×768 and on the CT40 in landscape:
 *
 *   --px = min(0.052vw, 0.0926vh)   →   1 unit = 1px on a 1920×1080 screen
 *
 * `u(n)` therefore means «n pixels on a 1080p screen», scaled by whichever
 * axis is tightest. Combined with a flex column that never lets the middle
 * overflow (see StationDisplay), nothing can be pushed off the glass: the
 * action bar and the footer always stay in view.
 */
export const SCREEN_UNIT = { '--px': 'min(0.052vw, 0.0926vh)' } as unknown as Record<string, string>;

/** n pixels at 1920×1080, scaled to the real screen. */
export const u = (n: number): string => `calc(var(--px) * ${n})`;

export type GuidanceTone = 'SCAN' | 'ALERT' | 'DONE' | 'WAIT';

/** v3 screen roles — a station has a SET of these, one per physical screen. */
export type DisplayView = 'BOARD' | 'ACTION' | 'QUEUE' | 'ALERTS' | 'PRINT' | 'STATS';
export type AndonState = 'OK' | 'ATTENTION' | 'PROBLEM' | 'IDLE';

export const VIEW_LABELS: Record<DisplayView, string> = {
  BOARD: 'Board — full station context',
  ACTION: 'Next action — one instruction only',
  QUEUE: 'Still expected — the work list',
  ALERTS: 'Andon — problems and calls only',
  PRINT: 'Print — labels only',
  STATS: 'Shift totals — numbers only',
};

/** The colour of the line, the same on every role. */
export const ANDON_STYLE: Record<AndonState, { color: string; label: string }> = {
  OK: { color: '#39d98a', label: 'RUNNING' },
  ATTENTION: { color: '#f2c15c', label: 'ATTENTION' },
  PROBLEM: { color: '#ff4d4d', label: 'PROBLEM' },
  IDLE: { color: '#5b6b7a', label: 'IDLE' },
};

/** The role this snapshot says it is (defaults to BOARD: never guess a role). */
export function snapshotView(snap: DisplaySnapshot | null): DisplayView {
  const v = snap?.options?.view;
  return v && v in VIEW_LABELS ? v : 'BOARD';
}

export interface DisplayGuidance {
  code: string;
  instruction: string;
  detail?: string | null;
  tone: GuidanceTone;
}

export interface DisplayQueueItem {
  code?: string | null;
  productName?: string | null;
  remaining: number;
  expected: number;
  hint?: string;
}

export interface DisplayAlert {
  id: string;
  kind: string;
  code?: string | null;
  reason: string;
  at: string;
  severity: string;
}

export interface DisplayStats {
  since?: string;
  scans: number;
  units: number;
  cartons: number;
  stored: number;
  transfersOut: number;
  actions: number;
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

/**
 * How long the current operation has been running ("42m", "2h05") — the
 * handover context a second operator needs. Pure, so it is unit tested.
 */
export function formatDuration(from: string | Date | null | undefined, now = Date.now()): string {
  if (!from) return '—';
  const start = +new Date(from);
  if (!Number.isFinite(start)) return '—';
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${String(m).padStart(2, '0')}`;
}

/** One line per queue row: "SA-4471 — Chair · 13 of 50 units left". */
export function queueLine(item: DisplayQueueItem): string {
  const id = [item.code, item.productName].filter(Boolean).join(' — ') || 'Product';
  return `${id} · ${item.hint ?? `${item.remaining} of ${item.expected} units left`}`;
}

/** Colour per guidance tone — one meaning per colour on every screen. */
export const GUIDANCE_STYLE: Record<GuidanceTone, { color: string; bg: string; label: string }> = {
  SCAN: { color: '#7cc4ff', bg: 'rgba(58,140,255,0.14)', label: 'NEXT ACTION' },
  ALERT: { color: '#ff8f6b', bg: 'rgba(255,93,93,0.16)', label: 'ATTENTION' },
  DONE: { color: '#5de2a0', bg: 'rgba(57,217,138,0.14)', label: 'READY TO FINISH' },
  WAIT: { color: '#f2c15c', bg: 'rgba(242,193,92,0.13)', label: 'WAITING' },
};

/** Severity → colour for the alerts strip (HIGH first). */
export function alertColor(severity: string | null | undefined): string {
  const s = (severity ?? '').toUpperCase();
  if (s === 'HIGH' || s === 'URGENT') return '#ff6b6b';
  if (s === 'MEDIUM' || s === 'WARNING') return '#f2c15c';
  return '#7cc4ff';
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
