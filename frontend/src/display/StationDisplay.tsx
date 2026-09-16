import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { DisplayAction, DisplayAlert, DisplayMessage, DisplaySnapshot, DisplayView } from './display-view';
import { ActionView, AlertsView, AndonBar, PrintView, QueueView, StatsView, VIEW_TITLES } from './StationViews';
import { SCREEN_UNIT, u } from './display-view';
import {
  ACTION_LABELS, GUIDANCE_STYLE, alertColor, formatDuration, queueLine, snapshotView,
  EXCEPTION_REASONS,
  MESSAGE_STYLE,
  availableActions,
  relativeTime,
  soundCueFor,
  topMessage,
  viewState,
} from './display-view';
import { printLabelByTransport, type LabelPayload } from './display-print';

/**
 * Station Display page (owner order 2026-09-16; stage 2 the same day).
 * /display/:token — a full-screen live view for any browser screen (PC / TV /
 * tablet) that ALSO helps the operator at the station:
 *
 *  - READ  : the same transactions the CT40 wrote (same ids), live over SSE;
 *  - ASSIST: NEXT/sound cues, operator messages from the admin;
 *  - ACT   : print / reprint a label, acknowledge an alert, call a supervisor,
 *            report a problem — ONLY when the admin switched that display to
 *            interactive. The backend refuses every other case, so the button
 *            bar is a rendering of the server's answer, never a client rule.
 *
 * Every action reports its real result (a label that failed to print says so),
 * and each one is audited with this display's identity.
 */

const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '');

const STATE_TEXT: Record<string, { label: string; color: string }> = {
  IDLE: { label: 'WAITING FOR NEXT OPERATION', color: '#8aa0b4' },
  PROCESSING: { label: 'PROCESSING…', color: '#4da3ff' },
  SUCCESS: { label: '✓ CONFIRMED', color: '#39d98a' },
  ERROR: { label: '✕ ERROR', color: '#ff5d5d' },
};

type Toast = { kind: 'ok' | 'err'; text: string } | null;

export default function StationDisplay() {
  const { token = '' } = useParams();
  const [snap, setSnap] = useState<DisplaySnapshot | null>(null);
  const [fatal, setFatal] = useState<'NOT_FOUND' | null>(null);
  const [live, setLive] = useState(false); // stream connected
  const [clock, setClock] = useState(() => Date.now());
  const [muted, setMuted] = useState(() => localStorage.getItem(`display-muted:${token}`) === '1');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [dialog, setDialog] = useState<'help' | 'exception' | null>(null);
  const [note, setNote] = useState('');
  const [reasonType, setReasonType] = useState(EXCEPTION_REASONS[0].type);
  const [lastJob, setLastJob] = useState<{ id: string; ref: string | null } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/v1/display-views/${token}`, { cache: 'no-store' });
      if (r.status === 404) { setFatal('NOT_FOUND'); return; }
      if (!r.ok) return;
      setSnap((await r.json()) as DisplaySnapshot);
    } catch { /* offline — the banner shows; keep polling */ }
  }, [token]);

  useEffect(() => { void poll(); }, [poll]);

  // SSE stream + self-healing poll + 1s clock for the relative timestamps.
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/v1/display-views/${token}/stream`);
    es.addEventListener('snapshot', (ev) => {
      try { setSnap(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
    });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    const fallback = setInterval(() => { if (!live) void poll(); }, 10_000);
    const tick = setInterval(() => setClock(Date.now()), 1_000);
    return () => { es.close(); clearInterval(fallback); clearInterval(tick); };
  }, [token, live, poll]);

  // ----------------------------------------------------------------
  // SOUND — a station screen must be audible across the aisle.
  // ----------------------------------------------------------------
  const prevCue = useRef<{ lastScanId: string | null; errorType: string | null; messageId: string | null }>({
    lastScanId: null, errorType: null, messageId: null,
  });
  const audioCtx = useRef<AudioContext | null>(null);

  const beep = useCallback((pattern: Array<[number, number, number]>) => {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      audioCtx.current ??= new Ctor();
      const ctx = audioCtx.current;
      if (ctx.state === 'suspended') void ctx.resume();
      let at = ctx.currentTime;
      for (const [freq, ms, gain] of pattern) {
        const osc = ctx.createOscillator();
        const vol = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        vol.gain.value = gain;
        osc.connect(vol);
        vol.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + ms / 1000);
        at += ms / 1000 + 0.03;
      }
    } catch { /* audio is a bonus — never break the screen */ }
  }, []);

  const soundAllowed = snap?.options?.sound !== false && !muted;

  useEffect(() => {
    const cue = soundCueFor(snap, prevCue.current);
    prevCue.current = {
      lastScanId: snap?.lastScan?.id ?? null,
      errorType: snap?.error?.type ?? null,
      messageId: topMessage(snap)?.id ?? null,
    };
    if (!cue || !soundAllowed) return;
    if (cue === 'SCAN_OK') beep([[1180, 90, 0.05]]);
    else if (cue === 'ERROR') beep([[320, 220, 0.08], [320, 220, 0.08]]);
    else beep([[880, 160, 0.07], [1320, 160, 0.07], [880, 160, 0.07]]);
  }, [snap, soundAllowed, beep]);

  // Unlock audio on the first human interaction (browser autoplay policy).
  useEffect(() => {
    const unlock = () => { try { audioCtx.current?.resume(); } catch { /* ignore */ } };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // ----------------------------------------------------------------
  // ACTIONS
  // ----------------------------------------------------------------
  const post = useCallback(async (path: string, body: unknown, label: string) => {
    setBusy(label);
    try {
      const r = await fetch(`${API_BASE}/v1/display-views/${token}/${path}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        throw new Error(String(data.message ?? r.status));
      }
      void poll();
      return data;
    } catch (e) {
      setToast({ kind: 'err', text: `${label} failed: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    } finally {
      setBusy(null);
    }
  }, [token, poll]);

  const actions = useMemo(
    () => availableActions(snap, { hasPrintable: Boolean(snap?.lastScan), hasReprintable: Boolean(lastJob) }),
    [snap, lastJob],
  );

  const runPrint = useCallback(async (reprintOf?: string) => {
    const label = reprintOf ? 'Reprint' : 'Print';
    const data = await post('actions/print', reprintOf ? { reprintOf } : { target: 'SCAN' }, label);
    const job = (data?.job ?? null) as { id: string; targetRef: string | null; transport: string; payload: LabelPayload } | null;
    if (!job) return;
    const outcome = await printLabelByTransport(job.payload, (job.transport as 'BROWSER' | 'BRIDGE' | 'CT40') ?? 'BROWSER');
    await post(`actions/print/${job.id}/result`, {
      status: outcome.ok ? 'PRINTED' : 'FAILED',
      error: outcome.ok ? undefined : outcome.error,
    }, 'Print result');
    if (outcome.ok) {
      setLastJob({ id: job.id, ref: job.targetRef });
      setToast({
        kind: 'ok',
        text: `Label ${job.targetRef ?? ''} sent to ${outcome.via}${'fallback' in outcome && outcome.fallback ? ` (bridge: ${outcome.fallback})` : ''}`,
      });
    } else {
      setToast({ kind: 'err', text: `Print failed: ${outcome.error}` });
    }
  }, [post]);

  const runHelp = useCallback(async (urgent: boolean) => {
    const res = await post('actions/help', { note, urgent }, 'Call supervisor');
    if (res) setToast({ kind: 'ok', text: res.notified ? `Supervisor notified (${res.notified})` : 'Supervisor requested' });
    setDialog(null);
    setNote('');
  }, [post, note]);

  const runException = useCallback(async () => {
    if (!note.trim()) { setToast({ kind: 'err', text: 'Describe the problem first' }); return; }
    const res = await post('actions/exception', { type: reasonType, reason: note }, 'Report problem');
    if (res) setToast({ kind: 'ok', text: `Exception ${res.exceptionCode} created` });
    setDialog(null);
    setNote('');
  }, [post, note, reasonType]);

  const runAck = useCallback(async () => {
    const res = await post('actions/ack', {}, 'Acknowledge');
    if (res) setToast({ kind: 'ok', text: 'Acknowledged' });
  }, [post]);

  const ackMessage = useCallback(async (m: DisplayMessage) => {
    await post(`messages/${m.id}/ack`, {}, 'Message');
  }, [post]);

  /** "SEEN" on an alert row: the SAME audited ACK action as the action bar. */
  const acknowledgeAlert = useCallback(async (a: DisplayAlert) => {
    const label = `${a.kind}${a.code ? ` ${a.code}` : ''}`;
    const res = await post('actions/ack', { note: `${label} seen at the station`, refId: a.id }, 'Acknowledge');
    if (res) setToast({ kind: 'ok', text: `${label} acknowledged` });
  }, [post]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  async function goFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch { /* browser refused — button stays for another tap */ }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStorage.setItem(`display-muted:${token}`, next ? '1' : '0');
  }

  if (fatal === 'NOT_FOUND') {
    return (
      <div style={{ ...wrap, justifyContent: 'center' }}>
        <div style={{ ...big(28), color: '#ff5d5d' }}>Display not found</div>
        <div style={mid}>This display URL is invalid or was regenerated by the admin.</div>
      </div>
    );
  }

  const state = viewState(snap, clock);
  const st = STATE_TEXT[state] ?? STATE_TEXT.IDLE;
  const scan = snap?.lastScan ?? null;
  const progress = snap?.progress ?? null;
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const message = topMessage(snap);
  const msgStyle = MESSAGE_STYLE[message?.severity ?? 'INFO'] ?? MESSAGE_STYLE.INFO;
  // ASSIST LAYER — everything the server computed for this station.
  const nowMs = clock;
  const guidance = snap?.guidance ?? null;
  const gStyle = GUIDANCE_STYLE[guidance?.tone ?? 'WAIT'] ?? GUIDANCE_STYLE.WAIT;
  const waiting = snap?.waiting ?? null;
  const alerts = snap?.alerts ?? [];
  const queue = snap?.queue ?? [];
  const stats = snap?.stats ?? null;
  const showAction = (a: DisplayAction) => actions.includes(a);
  /**
   * SCREEN ROLE (v3): the server already filtered the payload for this role —
   * here it only decides which LAYOUT the operator sees. BOARD is the original
   * full station board and stays untouched.
   */
  const view: DisplayView = snapshotView(snap);
  const roleProps = {
    snap, now: clock, actions, busy,
    onPrint: () => void runPrint(),
    onReprint: () => void runPrint(lastJob?.id),
    onAckAlert: (a: DisplayAlert) => void acknowledgeAlert(a),
    lastJob,
  };

  return (
    <div ref={rootRef} style={{ ...wrap, justifyContent: 'space-between' }} data-testid="station-display" data-view={view}>
      {/* header: station + live/offline pill (§23) */}
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: u(24), flexShrink: 0 }}>
        <div>
          <div style={{ ...big(64, 800), letterSpacing: 2 }}>{(snap?.station?.name ?? snap?.display?.name ?? '…').toUpperCase()}</div>
          {snap?.station?.code && <div style={{ ...mid, opacity: 0.7 }}>{snap.station.code} · {snap.station.department}</div>}
          {view !== 'BOARD' && (
            <div style={{ fontSize: u(22), letterSpacing: 5, fontWeight: 800, opacity: 0.55, marginTop: 4 }}>
              {VIEW_TITLES[view]}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <span style={{
            fontSize: u(26), fontWeight: 700, padding: '6px 22px', borderRadius: 999,
            background: live ? 'rgba(57,217,138,.15)' : 'rgba(255,157,0,.18)',
            color: live ? '#39d98a' : '#ff9d00', border: `2px solid ${live ? '#39d98a55' : '#ff9d0055'}`,
          }} data-testid="connection-pill">
            {live ? '🟢 LIVE' : '🟠 RECONNECTING'}
          </span>
          {!live && <span style={{ ...mid, color: '#ff9d00' }}>Connection lost — reconnecting…</span>}
        </div>
      </header>

      {/* operator message (stage 2) — the supervisor speaks to this screen */}
      {message && (
        <div data-testid="operator-message" style={{
          display: 'flex', alignItems: 'center', gap: 24, padding: '18px 28px', borderRadius: 16,
          background: msgStyle.bg, border: `3px solid ${msgStyle.border}`, color: msgStyle.color,
        }}>
          <span style={{ fontSize: u(30), fontWeight: 800, letterSpacing: 1 }}>📣 {message.severity}</span>
          <span style={{ fontSize: u(40), fontWeight: 700, flex: 1 }}>{message.body}</span>
          {message.requireAck && (
            <button style={actionBtn('#2f9dff')} disabled={busy === 'Message'} onClick={() => void ackMessage(message)}>
              ✓ SEEN
            </button>
          )}
        </div>
      )}

      {/* ASSIST LAYER (owner order 2026-09-16): the NEXT ACTION band — the
          screen tells the operator what to do, not only what happened. */}
      {guidance && (
        <div data-testid="next-action" style={{
          display: 'flex', alignItems: 'center', gap: 26, padding: '20px 30px', borderRadius: 18,
          background: gStyle.bg, border: `3px solid ${gStyle.color}55`,
        }}>
          <span style={{ fontSize: u(26), fontWeight: 800, letterSpacing: 2, color: gStyle.color, minWidth: 210 }}>
            {gStyle.label}
          </span>
          <span style={{ flex: 1, textAlign: 'left' }}>
            <span style={{ display: 'block', fontSize: u(46), fontWeight: 800, color: gStyle.color }} data-testid="next-action-instruction">
              {guidance.instruction}
            </span>
            {guidance.detail && <span style={{ display: 'block', fontSize: u(30), opacity: 0.85 }}>{guidance.detail}</span>}
          </span>
          {waiting?.since && (
            <span style={{ ...mid, fontSize: u(24), opacity: 0.75 }}>since {formatDuration(waiting.since, nowMs)}</span>
          )}
        </div>
      )}

      {/* ALERTS: everything wrong or unanswered at this station, in one strip. */}
      {alerts.length > 0 && (
        <div data-testid="alerts" style={{ width: 'min(94vw, 1600px)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {alerts.map((a) => (
            <div key={`${a.kind}-${a.id}`} style={{
              display: 'flex', alignItems: 'center', gap: 18, padding: '12px 20px', borderRadius: 12,
              background: 'rgba(255,93,93,0.12)', border: `2px solid ${alertColor(a.severity)}66`, color: '#ffd9d9',
            }}>
              <span style={{ fontSize: u(26), fontWeight: 800, color: alertColor(a.severity), minWidth: 190 }}>
                {a.kind}{a.code ? ` ${a.code}` : ''}
              </span>
              <span style={{ flex: 1, fontSize: u(28) }}>{a.reason}</span>
              <span style={{ ...mid, fontSize: u(22), opacity: 0.8 }}>{relativeTime(a.at, nowMs)}</span>
              {a.kind !== 'HELP' && showAction('ack') && (
                <button style={actionBtn('#ff9d00')} disabled={busy === 'Alert'} onClick={() => void acknowledgeAlert(a)}>
                  ✓ SEEN
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {view !== 'BOARD' && <AndonBar snap={snap} now={clock} />}

      {/* body — BOARD renders the full station board below; every other role
          renders its own single-purpose layout (v3). */}
      {/* ONLY the middle section may shrink: min-height:0 + overflow:hidden is
          what stops a 12-digit code or a long alert list from pushing the
          action bar and the footer off the glass (owner report 2026-09-16). */}
      <main style={{
        display: 'flex', flexDirection: 'column', gap: u(20), alignItems: 'center', textAlign: 'center',
        flex: '1 1 auto', minHeight: 0, overflow: 'hidden', justifyContent: 'center', width: '100%',
      }}>
        {snap?.enabled === false ? (
          <div style={{ ...big(40), color: '#8aa0b4' }}>Display disabled by admin</div>
        ) : view === 'ACTION' ? (
          <ActionView {...roleProps} />
        ) : view === 'QUEUE' ? (
          <QueueView {...roleProps} />
        ) : view === 'ALERTS' ? (
          <AlertsView {...roleProps} />
        ) : view === 'PRINT' ? (
          <PrintView {...roleProps} />
        ) : view === 'STATS' ? (
          <StatsView {...roleProps} />
        ) : (
          <>
            {snap?.worker && (
              <div style={{ ...mid, fontSize: u(40) }}>Worker: <b>{snap.worker.code}</b>{snap.worker.name ? ` · ${snap.worker.name}` : ''}</div>
            )}
            {snap?.task && <div style={{ ...mid, fontSize: u(40) }}>Task: {snap.task.title}</div>}
            {snap?.operation && (
              <div style={{ ...mid, opacity: 0.8 }}>
                {snap.operation.label}{snap.operation.sessionCode ? ` · ${snap.operation.sessionCode}` : ''}
                {snap.operation.sessionStatus ? ` (${snap.operation.sessionStatus})` : ''}
                {snap.operation.startedAt ? ` · open ${formatDuration(snap.operation.startedAt, nowMs)}` : ''}
              </div>
            )}

            {scan ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ ...big(120, 800), letterSpacing: 4, wordBreak: 'break-all', maxWidth: '94vw' }} data-testid="last-scan-code">
                  {scan.code ?? scan.productName ?? scan.kind}
                </div>
                <div style={{ ...mid, fontSize: u(40) }}>
                  {scan.kind}
                  {snap?.customer && <span> · {snap.customer}</span>}
                  {typeof scan.quantity === 'number' && <span> · Qty {scan.quantity}</span>}
                </div>
              </div>
            ) : (
              <div style={{ ...big(56, 700), color: '#8aa0b4' }}>No scans yet</div>
            )}

            <div style={{ ...big(72, 800), color: st.color }} data-testid="state-line">{st.label}</div>
            {snap?.error && (
              <div style={{ ...mid, color: '#ff5d5d', fontSize: u(34) }}>
                {snap.error.type}{snap.error.reason ? ` — ${snap.error.reason}` : ''}
              </div>
            )}

            {snap?.recent && snap.recent.length > 0 && (
              <div data-testid="recent-feed" style={{ width: 'min(88vw, 1100px)', display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {snap.recent.slice(0, 8).map((r) => {
                  // Rows produced BY a screen (print / ack / help / exception /
                  // message) carry a sentence instead of a barcode: they must
                  // read as a log line, not as a product code.
                  const isScreenAction = r.status === 'DISPLAY';
                  return (
                    <div key={r.id} style={{ display: 'flex', gap: 18, alignItems: 'baseline', fontSize: isScreenAction ? 22 : 26, opacity: 0.92 }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.65 }}>
                        {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ minWidth: 190, fontWeight: 700, color: isScreenAction ? '#c9a2ff' : r.status && /RECEIVED|CONFIRMED|STORED|RECEIVING_COMPLETED/.test(r.status) ? '#39d98a' : '#4da3ff' }}>{r.kind}</span>
                      {isScreenAction ? (
                        <span style={{ opacity: 0.85, fontStyle: 'italic' }}>{r.code ?? '—'}</span>
                      ) : (
                        <>
                          <span style={{ fontWeight: 700, letterSpacing: 2 }}>{r.code ?? r.productName ?? '—'}</span>
                          {typeof r.quantity === 'number' && r.quantity !== 1 && <span>×{r.quantity}</span>}
                          {r.customerName && <span style={{ opacity: 0.7 }}>{r.customerName}</span>}
                          <span style={{ marginLeft: 'auto', opacity: 0.75 }}>{r.status ?? ''}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* EXPECTED NEXT — what is still coming at this station, so the
                operator can prepare instead of discovering it scan by scan. */}
            {queue.length > 0 && (
              <div data-testid="expected-queue" style={{ width: 'min(88vw, 1200px)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ ...mid, fontSize: u(26), letterSpacing: 2, opacity: 0.7, textAlign: 'left' }}>STILL EXPECTED</div>
                {queue.map((q) => (
                  <div key={`${q.code}-${q.remaining}`} title={queueLine(q)} style={{
                    display: 'flex', alignItems: 'center', gap: 18, fontSize: u(30), padding: '8px 18px',
                    borderRadius: 10, background: 'rgba(47,157,255,0.10)', border: '1px solid rgba(47,157,255,0.25)',
                  }}>
                    <span style={{ fontWeight: 800, letterSpacing: 1 }}>{q.code ?? '—'}</span>
                    {q.productName && <span style={{ opacity: 0.8 }}>{q.productName}</span>}
                    <span style={{ marginLeft: 'auto', fontWeight: 700, color: '#7cc4ff' }}>{q.hint ?? `${q.remaining} / ${q.expected}`}</span>
                  </div>
                ))}
              </div>
            )}

            {progress && (
              <div style={{ width: 'min(80vw, 900px)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ height: 34, borderRadius: 999, background: '#1c2733', overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg,#2f9dff,#39d98a)' }} />
                </div>
                <div style={{ ...mid, fontSize: u(38) }}>
                  {progress.done} / {progress.total} {progress.label ?? ''}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ACTION BAR (stage 2) — rendered only when the server says this screen may act */}
      {actions.length > 0 && snap?.enabled !== false && (
        <div data-testid="action-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: u(16), justifyContent: 'center', flexShrink: 0 }}>
          {actions.map((a) => (
            <button
              key={a}
              style={actionBtn(a === 'exception' ? '#ff9d00' : a === 'help' ? '#ff5d5d' : '#2f9dff')}
              disabled={busy !== null}
              onClick={() => {
                if (a === 'print') void runPrint();
                else if (a === 'reprint') void runPrint(lastJob?.id);
                else if (a === 'ack') void runAck();
                else setDialog(a === 'help' ? 'help' : 'exception');
              }}
            >
              {busy ? '…' : ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      )}

      {/* footer: fullscreen + sound + last update (§22) */}
      <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={goFullscreen} style={fsBtn}>⛶ Enter Fullscreen</button>
          <button onClick={toggleMute} style={fsBtn} data-testid="sound-toggle">
            {soundAllowed ? '🔔 Sound on' : '🔕 Muted'}
          </button>
        </div>
        <div style={{ ...mid, opacity: 0.7 }}>
          {stats && (
            <span data-testid="shift-totals" style={{ marginRight: 18 }}>
              TODAY · {stats.scans} scans · {stats.units} units · {stats.cartons} cartons
              {stats.stored ? ` · ${stats.stored} stored` : ''}
              {stats.transfersOut ? ` · ${stats.transfersOut} out` : ''}
              {stats.actions ? ` · ${stats.actions} screen actions` : ''}
            </span>
          )}
          Last update: {relativeTime(snap?.lastUpdate, clock)}
        </div>
      </footer>

      {/* dialogs: help / problem — big touch targets, one tap to a real record */}
      {dialog && (
        <div style={overlay} onClick={() => { setDialog(null); setNote(''); }}>
          <div style={sheet} onClick={(e) => e.stopPropagation()}>
            <div style={{ ...big(40, 800) }}>{dialog === 'help' ? 'CALL SUPERVISOR' : 'REPORT PROBLEM'}</div>
            {dialog === 'exception' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {EXCEPTION_REASONS.map((r) => (
                  <button
                    key={r.type}
                    onClick={() => setReasonType(r.type)}
                    style={{ ...chip, ...(reasonType === r.type ? chipOn : {}) }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            )}
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={dialog === 'help' ? 'What do you need? (optional)' : 'Describe the problem (required)'}
              style={input}
            />
            <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end' }}>
              <button style={fsBtn} onClick={() => { setDialog(null); setNote(''); }}>Cancel</button>
              {dialog === 'help' ? (
                <>
                  <button style={actionBtn('#ff9d00')} disabled={busy !== null} onClick={() => void runHelp(false)}>SEND</button>
                  <button style={actionBtn('#ff5d5d')} disabled={busy !== null} onClick={() => void runHelp(true)}>🚨 URGENT</button>
                </>
              ) : (
                <button style={actionBtn('#ff9d00')} disabled={busy !== null} onClick={() => void runException()}>CREATE EXCEPTION</button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div data-testid="toast" style={{
          position: 'fixed', bottom: 96, left: '50%', transform: 'translateX(-50%)',
          padding: '16px 30px', borderRadius: 14, fontSize: u(26), fontWeight: 700,
          background: toast.kind === 'ok' ? 'rgba(57,217,138,.16)' : 'rgba(255,93,93,.18)',
          border: `2px solid ${toast.kind === 'ok' ? '#39d98a77' : '#ff5d5d88'}`,
          color: toast.kind === 'ok' ? '#b8f5d6' : '#ffc9c9',
        }}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = {
  ...(SCREEN_UNIT as React.CSSProperties),
  position: 'fixed', inset: 0, zIndex: 50,
  // Fits the glass instead of overflowing it: the root is exactly the viewport
  // and the middle section is the only thing that may shrink (see <main>).
  height: '100dvh', overflow: 'hidden', boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column',
  padding: `${u(20)} ${u(40)}`,
  background: '#0b1118', color: '#eef4fa',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  gap: u(14),
};

function big(size: number, weight = 700): React.CSSProperties {
  return { fontSize: u(size), fontWeight: weight, lineHeight: 1.1, margin: 0 };
}

const mid: React.CSSProperties = { fontSize: u(28), fontWeight: 500, opacity: 0.9 };

const fsBtn: React.CSSProperties = {
  fontSize: u(22), fontWeight: 600, padding: '10px 26px', borderRadius: 12,
  background: '#16222e', color: '#cfe3f5', border: '2px solid #2a3b4d', cursor: 'pointer',
};

function actionBtn(color: string): React.CSSProperties {
  return {
    fontSize: u(30), fontWeight: 800, letterSpacing: 1, padding: `${u(18)} ${u(34)}`, borderRadius: u(16),
    background: `${color}22`, color: '#f4f9ff', border: `3px solid ${color}`, cursor: 'pointer',
    minWidth: u(220),
  };
}

const chip: React.CSSProperties = {
  fontSize: u(24), fontWeight: 700, padding: '12px 20px', borderRadius: 999,
  background: '#16222e', color: '#cfe3f5', border: '2px solid #2a3b4d', cursor: 'pointer',
};
const chipOn: React.CSSProperties = { background: '#2f9dff33', borderColor: '#2f9dff', color: '#fff' };

const input: React.CSSProperties = {
  fontSize: u(28), padding: '16px 20px', borderRadius: 12, width: '100%',
  background: '#0e1725', color: '#eef4fa', border: '2px solid #2a3b4d',
};

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(4,8,14,.72)', zIndex: 60,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
};

const sheet: React.CSSProperties = {
  width: 'min(900px, 92vw)', display: 'flex', flexDirection: 'column', gap: 18,
  background: '#0f1a26', border: '2px solid #24303d', borderRadius: 18, padding: 28,
};
