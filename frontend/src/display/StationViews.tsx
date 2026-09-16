import type { CSSProperties } from 'react';
import type { DisplayAlert, DisplaySnapshot, DisplayView } from './display-view';
import { GUIDANCE_STYLE, MESSAGE_STYLE, alertColor, formatDuration, relativeTime, u } from './display-view';

/**
 * SCREEN ROLES (owner order 2026-09-16, v3).
 *
 * A station does not have «a big screen» — it has a SET of screens, each with
 * ONE job, exactly like the andon boards / pick-to-light faces of a real
 * warehouse. The server already decided which blocks may leave the API for a
 * given role (VIEW_PRESETS); this file only *renders* that role:
 *
 *   ACTION → ONE instruction, giant, nothing else
 *   QUEUE  → what is still coming, biggest gap first
 *   ALERTS → the andon board: colour + problems + calls
 *   PRINT  → the label to print, and two giant buttons
 *   STATS  → shift totals, huge
 *
 * Board (the full station view) lives in StationDisplay.tsx and is untouched.
 */

export const VIEW_TITLES: Record<DisplayView, string> = {
  BOARD: 'STATION BOARD',
  ACTION: 'NEXT ACTION',
  QUEUE: 'WORK QUEUE',
  ALERTS: 'ANDON',
  PRINT: 'LABEL PRINTING',
  STATS: 'SHIFT TOTALS',
};

export interface ViewProps {
  snap: DisplaySnapshot | null;
  now: number;
  /** Present when the display may act (server truth) — the role decides the rest. */
  actions?: string[];
  busy?: string | null;
  onPrint?: () => void;
  onReprint?: () => void;
  onAckAlert?: (a: DisplayAlert) => void;
  lastJob?: { id: string; ref: string | null } | null;
}

const big = (size: number, weight = 900): CSSProperties => ({
  fontSize: u(size),
  fontWeight: weight,
  lineHeight: 1.05,
  letterSpacing: 1,
});

const panel: CSSProperties = {
  width: 'min(94vw, 1700px)',
  display: 'flex',
  flexDirection: 'column',
  gap: u(14),
  // A role never overflows the glass either: the panel may shrink and the rows
  // cap themselves, so the buttons of a role stay visible (2026-09-16).
  minHeight: 0,
  overflow: 'hidden',
};

/** The colour bar every role carries — readable from the far end of the aisle. */
export function AndonBar({ snap, now }: { snap: DisplaySnapshot | null; now: number }) {
  const andon = snap?.andon ?? null;
  const color =
    andon?.state === 'PROBLEM' ? '#ff4d4d'
      : andon?.state === 'ATTENTION' ? '#f2c15c'
        : andon?.state === 'OK' ? '#39d98a'
          : '#5b6b7a';
  return (
    <div
      data-testid="andon-bar"
      data-andon={andon?.state ?? 'IDLE'}
      style={{
        width: 'min(94vw, 1700px)', height: 14, borderRadius: 999, background: color,
        boxShadow: `0 0 26px ${color}88`,
      }}
      title={andon ? `${andon.state} · ${andon.code}` : ''}
    >
      <span className="sr-only">{andon?.state ?? 'IDLE'}</span>
    </div>
  );
}

/** ACTION — pick-to-light discipline: one instruction, as big as the screen allows. */
export function ActionView({ snap, now, busy, actions = [], onAckAlert }: ViewProps) {
  const g = snap?.guidance ?? null;
  const tone = GUIDANCE_STYLE[g?.tone ?? 'WAIT'];
  const message = snap?.messages?.[0] ?? null;
  const msgStyle = MESSAGE_STYLE[message?.severity ?? 'INFO'] ?? MESSAGE_STYLE.INFO;
  const alert = (snap?.alerts ?? [])[0] ?? null;

  return (
    <div style={{ ...panel, alignItems: 'center', textAlign: 'center', gap: 26 }}>
      {message && (
        <div style={{ ...panel, alignItems: 'center' }}>
          <div style={{
            width: 'min(94vw, 1700px)', padding: '14px 22px', borderRadius: 14,
            background: msgStyle.bg, border: `3px solid ${msgStyle.border}`, color: msgStyle.color,
            fontSize: u(34), fontWeight: 800,
          }}>
            📣 {message.severity} — {message.body}
          </div>
        </div>
      )}

      <div style={{ fontSize: u(30), letterSpacing: 6, fontWeight: 800, color: tone.color }}>
        {tone.label}
      </div>
      <div data-testid="action-instruction" style={{ ...big(96), color: tone.color }}>
        {g?.instruction ?? 'Waiting for the next operation'}
      </div>
      {g?.detail && <div style={{ fontSize: u(42), opacity: 0.85 }}>{g.detail}</div>}

      {alert && (
        <div
          data-testid="action-alert"
          style={{
            display: 'flex', alignItems: 'center', gap: 18, padding: '14px 24px', borderRadius: 14,
            background: 'rgba(255,93,93,0.14)', border: `3px solid ${alertColor(alert.severity)}66`,
          }}
        >
          <span style={{ fontSize: u(30), fontWeight: 800, color: alertColor(alert.severity) }}>
            {alert.kind}{alert.code ? ` ${alert.code}` : ''}
          </span>
          <span style={{ fontSize: u(32) }}>{alert.reason}</span>
          {actions.includes('ack') && onAckAlert && (
            <button onClick={() => onAckAlert(alert)} disabled={busy !== null} style={miniBtn('#ff9d00')}>
              ✓ SEEN
            </button>
          )}
        </div>
      )}

      <div style={{ fontSize: u(26), opacity: 0.6 }}>
        {snap?.station?.code} · {snap?.operation?.sessionCode ?? '—'} · last scan {relativeTime(snap?.lastScan?.at, now)}
      </div>
    </div>
  );
}

/** QUEUE — the operator sees what is coming, in order, with how much is left. */
export function QueueView({ snap, now }: ViewProps) {
  const queue = snap?.queue ?? [];
  const progress = snap?.progress ?? null;
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  return (
    <div style={panel}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ ...big(56) }}>STILL EXPECTED</span>
        {progress && (
          <span style={{ fontSize: u(40), fontWeight: 800, color: '#7cc4ff' }}>
            {progress.done} / {progress.total} {progress.label ?? ''}
          </span>
        )}
      </div>
      {progress && (
        <div style={{ height: 30, borderRadius: 999, background: '#1c2733', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#2f9dff,#39d98a)' }} />
        </div>
      )}
      {queue.length === 0 ? (
        <div style={{ ...big(52, 700), color: '#8aa0b4' }} data-testid="queue-empty">
          Nothing expected right now
        </div>
      ) : (
        <div data-testid="queue-rows" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {queue.map((q) => {
            const done = Math.max(0, q.expected - q.remaining);
            const rowPct = q.expected > 0 ? Math.min(100, Math.round((done / q.expected) * 100)) : 0;
            return (
              <div key={`${q.code}-${q.remaining}`} style={{
                display: 'flex', alignItems: 'center', gap: 22, padding: '14px 22px', borderRadius: 14,
                background: 'rgba(47,157,255,0.10)', border: '2px solid rgba(47,157,255,0.28)',
              }}>
                <span style={{ ...big(56, 900), minWidth: 320 }}>{q.code ?? '—'}</span>
                <span style={{ fontSize: u(34), opacity: 0.8, flex: 1 }}>{q.productName ?? ''}</span>
                <span style={{ width: 320, height: 22, borderRadius: 999, background: '#1c2733', overflow: 'hidden' }}>
                  <span style={{ display: 'block', width: `${rowPct}%`, height: '100%', background: '#39d98a' }} />
                </span>
                <span style={{ fontSize: u(40), fontWeight: 800, color: '#7cc4ff', minWidth: 260, textAlign: 'right' }}>
                  {q.remaining} / {q.expected}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: u(26), opacity: 0.6 }}>
        {snap?.operation?.label ?? '—'} {snap?.operation?.sessionCode ? `· ${snap.operation.sessionCode}` : ''} · updated{' '}
        {relativeTime(snap?.lastUpdate, now)}
      </div>
    </div>
  );
}

/** ALERTS — the andon board: the line state, the problems, the calls, aged. */
export function AlertsView({ snap, now, busy, actions = [], onAckAlert }: ViewProps) {
  const andon = snap?.andon ?? null;
  const alerts = snap?.alerts ?? [];
  const color =
    andon?.state === 'PROBLEM' ? '#ff4d4d'
      : andon?.state === 'ATTENTION' ? '#f2c15c'
        : andon?.state === 'OK' ? '#39d98a'
          : '#5b6b7a';
  const waitingFor = andon?.since ? formatDuration(andon.since, now) : null;
  return (
    <div style={{ ...panel, alignItems: 'center', textAlign: 'center' }}>
      <div
        data-testid="andon-state"
        style={{
          width: 'min(94vw, 1700px)', padding: '26px 30px', borderRadius: 20,
          background: `${color}22`, border: `5px solid ${color}`, color,
          ...big(84),
        }}
      >
        {andon?.state ?? 'IDLE'}
        <span style={{ display: 'block', fontSize: u(34), fontWeight: 700, opacity: 0.9 }}>
          {andon?.code ?? 'NOTHING_OPEN'}{waitingFor && waitingFor !== '—' ? ` · ${waitingFor}` : ''}
        </span>
      </div>
      {alerts.length === 0 ? (
        <div style={{ ...big(52, 700), color: '#8aa0b4' }}>No open problem at this station</div>
      ) : (
        <div data-testid="andon-alerts" style={{ ...panel, gap: 12 }}>
          {alerts.map((a) => (
            <div key={`${a.kind}-${a.id}`} style={{
              display: 'flex', alignItems: 'center', gap: 20, padding: '16px 22px', borderRadius: 14,
              background: 'rgba(255,93,93,0.12)', border: `3px solid ${alertColor(a.severity)}66`,
            }}>
              <span style={{ fontSize: u(34), fontWeight: 800, color: alertColor(a.severity), minWidth: 260, textAlign: 'left' }}>
                {a.kind}{a.code ? ` ${a.code}` : ''}
              </span>
              <span style={{ fontSize: u(34), flex: 1, textAlign: 'left' }}>{a.reason}</span>
              <span style={{ fontSize: u(26), opacity: 0.8 }}>{relativeTime(a.at, now)}</span>
              {a.kind !== 'HELP' && actions.includes('ack') && onAckAlert && (
                <button onClick={() => onAckAlert(a)} disabled={busy !== null} style={miniBtn('#ff9d00')}>
                  ✓ SEEN
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** PRINT — the label screen: what will print, and two giant buttons. */
export function PrintView({ snap, busy, actions = [], onPrint, onReprint, lastJob, now }: ViewProps) {
  const scan = snap?.lastScan ?? null;
  const canPrint = actions.includes('print');
  const canReprint = actions.includes('reprint');
  const transport = snap?.options?.printTransport ?? 'BROWSER';
  return (
    <div style={{ ...panel, alignItems: 'center', textAlign: 'center', gap: 30 }}>
      <div style={{ fontSize: u(32), letterSpacing: 6, fontWeight: 800, opacity: 0.7 }}>LABEL PRINTING</div>
      {scan ? (
        <>
          <div style={{ ...big(110), letterSpacing: 6 }} data-testid="print-target">{scan.code ?? '—'}</div>
          <div style={{ fontSize: u(40), opacity: 0.85 }}>
            {scan.kind} · {scan.productName ?? scan.customerName ?? ''} {typeof scan.quantity === 'number' && scan.quantity !== 1 ? `× ${scan.quantity}` : ''}
          </div>
          <div style={{ fontSize: u(30), opacity: 0.65 }}>
            last scan {relativeTime(scan.at, now)} · printed via {transport}
          </div>
          <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              data-testid="print-button"
              style={giantBtn('#2f9dff')}
              disabled={busy !== null || !canPrint}
              onClick={onPrint}
            >
              {busy === 'Print' ? '…' : '🖨 PRINT'}
            </button>
            <button
              style={giantBtn('#8aa0b4')}
              disabled={busy !== null || !canReprint || !lastJob}
              onClick={onReprint}
            >
              {busy === 'Reprint' ? '…' : '↻ REPRINT'}
            </button>
          </div>
          {lastJob && (
            <div style={{ fontSize: u(30), opacity: 0.8 }} data-testid="print-last-job">
              last job: {lastJob.ref ?? lastJob.id.slice(0, 8)}
            </div>
          )}
        </>
      ) : (
        <div style={{ ...big(60, 700), color: '#8aa0b4' }} data-testid="print-empty">
          Nothing to print yet — scan a product or a carton first
        </div>
      )}
      {!canPrint && (
        <div style={{ fontSize: u(26), opacity: 0.6 }}>This screen is not allowed to print (admin switch / role).</div>
      )}
    </div>
  );
}

/** STATS — the production board for the supervisor's wall. */
export function StatsView({ snap, now }: ViewProps) {
  const s = snap?.stats ?? null;
  const items: Array<{ label: string; value: number | string; color?: string }> = [
    { label: 'SCANS', value: s?.scans ?? 0 },
    { label: 'UNITS', value: s?.units ?? 0, color: '#7cc4ff' },
    { label: 'CARTONS', value: s?.cartons ?? 0 },
    { label: 'STORED', value: s?.stored ?? 0 },
    { label: 'TRANSFERS OUT', value: s?.transfersOut ?? 0 },
    { label: 'SCREEN ACTIONS', value: s?.actions ?? 0, color: '#8aa0b4' },
  ];
  return (
    <div style={{ ...panel, gap: 30 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ ...big(56) }}>TODAY — {(snap?.station?.code ?? '').toUpperCase()}</span>
        <span style={{ fontSize: u(30), opacity: 0.7 }}>{snap?.station?.name ?? ''}</span>
      </div>
      <div data-testid="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 22 }}>
        {items.map((it) => (
          <div key={it.label} style={{
            padding: '26px 24px', borderRadius: 18, background: 'rgba(255,255,255,0.04)',
            border: '2px solid rgba(255,255,255,0.08)', textAlign: 'center',
          }}>
            <div style={{ ...big(96), color: it.color ?? '#e8eef5' }}>{it.value}</div>
            <div style={{ fontSize: u(28), letterSpacing: 3, opacity: 0.7, fontWeight: 700 }}>{it.label}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: u(26), opacity: 0.6 }}>
        since {relativeTime(s?.since, now)} · updated {relativeTime(snap?.lastUpdate, now)}
      </div>
    </div>
  );
}

function giantBtn(bg: string): CSSProperties {
  return {
    fontSize: u(52), fontWeight: 900, letterSpacing: 2, padding: '22px 46px', borderRadius: 18,
    border: 'none', background: bg, color: '#0b1218', cursor: 'pointer', minWidth: 300,
  };
}

function miniBtn(bg: string): CSSProperties {
  return {
    fontSize: u(26), fontWeight: 800, padding: '8px 18px', borderRadius: 10,
    border: 'none', background: bg, color: '#0b1218', cursor: 'pointer',
  };
}

/** Dispatch table used by StationDisplay — one place decides which role renders. */
export const VIEW_COMPONENTS: Record<DisplayView, (p: ViewProps) => JSX.Element> = {
  BOARD: ActionView, // replaced by the page itself (the board IS StationDisplay)
  ACTION: ActionView,
  QUEUE: QueueView,
  ALERTS: AlertsView,
  PRINT: PrintView,
  STATS: StatsView,
};
