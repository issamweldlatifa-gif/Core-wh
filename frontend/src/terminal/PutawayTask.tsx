import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  putawayApi,
  type PutawayFlash,
  type PutawaySession,
  type QueueCarton,
} from './putaway-api';
import { detectCapabilities, type ScanSource } from '../modules/receiving-terminal/scan-source';
import { beepSuccess, beepError, beepInfo, beepDone } from '../modules/receiving-terminal/feedback';
import type { ScanOutcome } from '../modules/receiving-terminal/ContinuousScanner';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import './putaway-task.css';

const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

/**
 * Putaway / stowing terminal.
 *
 * The interaction is a deliberate two-step loop, because that is the physical
 * job: pick up a carton, scan it, walk to a shelf, scan the shelf. The screen
 * therefore always makes exactly one thing the "next action" (§4), and the
 * scanner knows which of the two it is currently capturing.
 *
 * As in Receiving, nothing is considered stored until the backend confirms it.
 */

type Step = 'CARTON' | 'LOCATION';

/**
 * Distinct CATEGORY/SUBCATEGORY pairs for a queued carton. Falls back to the
 * legacy `categories` list when the backend predates per-line classification.
 */
function dedupeClassification(c: QueueCarton) {
  const lines = c.classification ?? [];
  if (lines.length === 0) {
    return (c.categories ?? []).map((cat) => ({
      category: cat === 'UNKNOWN' ? null : cat,
      subcategory: null as string | null,
      status: (cat === 'UNKNOWN' ? 'NEEDS_REVIEW' : 'CONFIRMED') as 'CONFIRMED' | 'NEEDS_REVIEW',
    }));
  }
  const seen = new Map<string, (typeof lines)[number]>();
  for (const l of lines) {
    const key = `${l.category ?? ''}|${l.subcategory ?? ''}|${l.status}`;
    if (!seen.has(key)) seen.set(key, l);
  }
  return Array.from(seen.values());
}

interface StagedCarton {
  code: string;
  arrivalCode: string | null;
  customerName: string | null;
  currentLocation: string | null;
}

export default function PutawayTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const caps = useMemo(() => detectCapabilities(), []);
  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const [session, setSession] = useState<PutawaySession | null>(null);
  const [queue, setQueue] = useState<QueueCarton[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('CARTON');
  const [staged, setStaged] = useState<StagedCarton | null>(null);
  const [manual, setManual] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [log, setLog] = useState<Array<{ t: string; text: string; kind: 'ok' | 'bad' | 'info' }>>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const stamps = useRef<number[]>([]);

  const push = useCallback((text: string, kind: 'ok' | 'bad' | 'info') => {
    setLog((l) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 40));
    setLastAction(text);
  }, [setLastAction]);

  const report = useCallback((kind: 'ok' | 'bad' | 'info', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    if (kind === 'ok') beepSuccess();
    else if (kind === 'bad') beepError();
    else beepInfo();
  }, []);

  const refreshQueue = useCallback(async () => {
    try { setQueue(await putawayApi.queue()); } catch { /* queue is advisory */ }
  }, []);

  // Resume an open session so a refresh never loses the worker's place.
  useEffect(() => {
    (async () => {
      try {
        const existing = await putawayApi.active();
        if (existing) setSession(existing);
        await refreshQueue();
      } catch (e: any) {
        setError(e?.response?.data?.message ?? 'Could not load putaway.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshQueue]);

  useEffect(() => {
    if (!session) { setStatus(null); return; }
    setStatus(
      step === 'CARTON'
        ? { text: 'SCAN CARTON', kind: 'info' }
        : { text: `PLACE ${staged?.code ?? ''}`, kind: 'ok' },
    );
  }, [session, step, staged, setStatus]);

  async function startSession() {
    setBusy(true); setError(null);
    try {
      const s = await putawayApi.start({
        deviceType: caps.deviceType,
        deviceName: caps.userAgent.slice(0, 80),
      });
      setSession(s);
      push(`session ${s.code} started`, 'info');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not start putaway.');
    } finally { setBusy(false); }
  }

  /** Human-readable reason for a rejected scan (§27). */
  function rejectionText(f: PutawayFlash): string {
    switch (f.kind) {
      case 'UNKNOWN_CARTON': return `${f.code} — UNKNOWN CARTON`;
      case 'UNKNOWN_LOCATION': return `${f.code} — UNKNOWN LOCATION`;
      case 'CARTON_NOT_RECEIVED': return `${f.code} — NOT RECEIVED (${f.status})`;
      case 'LOCATION_UNAVAILABLE': return `${f.code} — LOCATION ${f.status}`;
      default: return 'NOT ACCEPTED';
    }
  }

  /**
   * One entry point for every input device (§11): the current `step` decides
   * whether the value is a carton or a location.
   */
  const submitCode = useCallback(async (raw: string, source: ScanSource) => {
    const value = raw.trim();
    if (!value || busy || !session) return;
    setBusy(true);
    try {
      if (step === 'CARTON') {
        const flash = await putawayApi.scanCarton(value);
        if (flash.kind !== 'CARTON_READY') {
          report('bad', rejectionText(flash));
          push(rejectionText(flash), 'bad');
          return;
        }
        setStaged({
          code: flash.carton.externalCartonId,
          arrivalCode: flash.carton.arrivalCode,
          customerName: flash.carton.customerName,
          currentLocation: flash.carton.currentLocation,
        });
        setStep('LOCATION');
        report('info', `${flash.carton.externalCartonId} → SCAN LOCATION`);
        push(`carton ${flash.carton.externalCartonId} staged`, 'info');
        return;
      }

      // LOCATION step -> commit the placement.
      if (!staged) { setStep('CARTON'); return; }
      const res = await putawayApi.place(session.id, {
        cartonCode: staged.code,
        locationCode: value,
        locationSource: source,
      });
      if (res.flash.kind !== 'STORED') {
        report('bad', rejectionText(res.flash));
        push(rejectionText(res.flash), 'bad');
        return;
      }
      if (res.session) setSession(res.session);
      const verb = res.flash.moved ? 'MOVED TO' : 'STORED AT';
      report('ok', `${res.flash.carton.externalCartonId} ${verb} ${res.flash.location.locationCode}`);
      push(`${res.flash.carton.externalCartonId} → ${res.flash.location.locationCode}`, 'ok');
      setStaged(null);
      setStep('CARTON');
      await refreshQueue();
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, session, step, staged, report, push, refreshQueue]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const s = stamps.current;
      const fast = s.length > 4 && (s[s.length - 1] - s[0]) / s.length < 40;
      stamps.current = [];
      const v = manual;
      setManual('');
      void submitCode(v, fast ? 'EXTERNAL_SCANNER' : 'MANUAL');
      return;
    }
    if (e.key.length === 1) {
      stamps.current.push(Date.now());
      if (stamps.current.length > 64) stamps.current.shift();
    }
  }

  async function finish() {
    if (!session) return;
    setBusy(true);
    try {
      const s = await putawayApi.complete(session.id);
      setSession(s);
      beepDone();
      push('putaway completed', 'ok');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not complete.');
    } finally { setBusy(false); }
  }

  if (loading) return <div className="os-empty">loading putaway…</div>;

  // ---------- no session yet ----------
  if (!session) {
    return (
      <div className="pt-start">
        <h1 className="pt-h1">PUTAWAY</h1>
        <p className="os-muted">
          Move received cartons onto their storage locations.
        </p>
        {error && (
          <div className="pt-error">
            {error}
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="os-btn"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  try {
                    const existing = await putawayApi.active();
                    if (existing) setSession(existing);
                    await refreshQueue();
                  } catch (e: any) {
                    setError(e?.response?.data?.message ?? 'Could not load putaway.');
                  }
                }}
              >
                ↻ RETRY
              </button>
            </div>
          </div>
        )}
        {/* When loading failed, the queue count is unknown — showing "0" would
            mislead the worker into thinking there is genuinely nothing to do. */}
        <div className="pt-start-metric">
          <div className="pt-metric-v">{error ? '—' : queue.length}</div>
          <div className="pt-metric-l">CARTONS WAITING</div>
        </div>
        <button className="os-btn os-btn--primary pt-big" disabled={busy || !!error} onClick={startSession}>
          START PUTAWAY
        </button>
        {queue.length > 0 && (
          <ul className="pt-queue-preview">
            {queue.slice(0, 8).map((c) => (
              <li key={c.id}>
                <span className="os-mono">{c.externalCartonId}</span>
                <span className="os-muted"> · {c.customerName ?? c.arrivalCode ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const done = session.status === 'COMPLETED';

  return (
    <div className="pt">
      <div className="pt-bar">
        <div>
          <span className="pt-session">{session.code}</span>
          {session.station && <span className="os-muted"> · {session.station.code}</span>}
        </div>
        <div className="os-row">
          {!done && (
            <button className="os-btn os-btn--primary" onClick={() => setScannerOpen(true)}>
              OPEN SCANNER
            </button>
          )}
          {!done && <button className="os-btn" disabled={busy} onClick={finish}>FINISH</button>}
        </div>
      </div>

      {error && <div className="pt-error">{error}</div>}

      {/* The two-step state is the primary information on the screen. */}
      {!done && (
        <div className="pt-steps">
          <div className={`pt-step${step === 'CARTON' ? ' is-active' : ''}${staged ? ' is-done' : ''}`}>
            <div className="pt-step-n">1</div>
            <div>
              <div className="pt-step-t">CARTON</div>
              <div className="pt-step-v">{staged ? staged.code : '— scan a carton —'}</div>
              {staged?.customerName && <div className="os-muted">{staged.customerName}</div>}
              {staged?.currentLocation && (
                <div className="pt-warn">currently at {staged.currentLocation} — this will MOVE it</div>
              )}
            </div>
          </div>
          <div className={`pt-step${step === 'LOCATION' ? ' is-active' : ''}`}>
            <div className="pt-step-n">2</div>
            <div>
              <div className="pt-step-t">LOCATION</div>
              <div className="pt-step-v">
                {step === 'LOCATION' ? '— scan the shelf —' : 'waiting for carton'}
              </div>
            </div>
          </div>
        </div>
      )}

      {!done && (
        <div className="pt-input">
          <label className="os-label" htmlFor="pt-field">
            {step === 'CARTON' ? 'SCAN OR TYPE CARTON' : 'SCAN OR TYPE LOCATION'}
          </label>
          <div className="os-row">
            <input
              id="pt-field"
              ref={inputRef}
              className="os-input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={onKey}
              placeholder={step === 'CARTON' ? 'CTN-…' : 'TUN-MAIN-…'}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
              autoFocus
            />
            <button
              className="os-btn"
              disabled={busy || !manual.trim()}
              onClick={() => { const v = manual; setManual(''); void submitCode(v, 'MANUAL'); }}
            >
              ENTER
            </button>
            {staged && (
              <button
                className="os-btn"
                disabled={busy}
                onClick={() => { setStaged(null); setStep('CARTON'); push('carton cleared', 'info'); }}
              >
                CANCEL
              </button>
            )}
          </div>
        </div>
      )}

      {outcome && !scannerOpen && (
        <div key={outcome.token} className={`pt-outcome pt-outcome--${outcome.kind}`}>
          {outcome.kind === 'ok' ? '✓ ' : outcome.kind === 'bad' ? '✕ ' : ''}{outcome.text}
        </div>
      )}

      <div className="pt-metrics">
        <Metric v={String(session.tally.storedThisSession)} l="STORED NOW" ok />
        <Metric v={String(session.tally.pendingCartons)} l="STILL WAITING" />
        <Metric v={String(session.tally.totalPlacements)} l="PLACEMENTS" />
      </div>

      <div className="pt-cols">
        <section className="os-card">
          <h2 className="os-card-title">Waiting cartons</h2>
          <div className="pt-list">
            {queue.length === 0 && <div className="os-muted">Nothing left to put away.</div>}
            {queue.map((c) => (
              <button
                key={c.id}
                className="pt-queue-row"
                disabled={busy || step === 'LOCATION'}
                onClick={() => void submitCode(c.externalCartonId, 'MANUAL')}
                title="Select this carton"
              >
                <span className="os-mono">{c.externalCartonId}</span>
                <span className="os-muted">{c.customerName ?? c.arrivalCode ?? ''}</span>
                {/* CATEGORY / SUBCATEGORY — validated classification. */}
                {dedupeClassification(c).map((cl) => (
                  <span
                    key={`${cl.category}|${cl.subcategory}`}
                    className={`os-tag ${cl.status === 'CONFIRMED' ? 'os-tag--ok' : 'os-tag--warn'}`}
                  >
                    {cl.category ?? 'UNKNOWN'}{cl.subcategory ? ` / ${cl.subcategory}` : ''}
                  </span>
                ))}
                {/* DESTINATION — resolved from configuration, never guessed. */}
                {c.sorting?.kind === 'DESTINATION' && (
                  <span className="os-tag os-tag--ok">→ {c.sorting.zone.code}</span>
                )}
                {c.sorting?.kind === 'NEEDS_REVIEW' && (
                  <span className="os-tag os-tag--err">MANUAL REVIEW REQUIRED</span>
                )}
                {c.sorting?.kind === 'UNMAPPED' && (
                  <span className="os-tag os-tag--warn">NO DESTINATION CONFIGURED</span>
                )}
                {c.sorting?.kind === 'AMBIGUOUS' && (
                  <span className="os-tag os-tag--warn">MULTIPLE DESTINATIONS</span>
                )}
              </button>
            ))}
          </div>
        </section>

        <section className="os-card">
          <h2 className="os-card-title">This session</h2>
          <div className="pt-list">
            {session.placements.length === 0 && <div className="os-muted">No placements yet.</div>}
            {session.placements.map((p) => (
              <div key={p.id} className={`pt-place${p.releasedAt ? ' is-released' : ''}`}>
                <span className="os-mono">{p.cartonCode}</span>
                <span className="pt-arrow">→</span>
                <span className="os-mono">{p.locationCode}</span>
                {p.releasedAt && <span className="os-tag os-tag--muted">moved</span>}
              </div>
            ))}
          </div>
        </section>
      </div>

      {log.length > 0 && (
        <section className="os-card">
          <h2 className="os-card-title">Activity</h2>
          <div className="pt-log">
            {log.map((l, i) => (
              <div key={i} className={`pt-log-item ${l.kind}`}>
                <span className="os-muted">{l.t}</span> {l.text}
              </div>
            ))}
          </div>
        </section>
      )}

      {done && <div className="pt-done">SESSION COMPLETED</div>}

      {scannerOpen && (
        <Suspense fallback={<div className="pt-scanner-loading">STARTING SCANNER…</div>}>
          <ContinuousScanner
            title={step === 'CARTON' ? 'SCAN CARTON' : `PLACE ${staged?.code ?? ''}`}
            enableOcr={ocrAllowed}
            outcome={outcome}
            onDetected={(value, source) => { void submitCode(value, source); }}
            onClose={() => { setScannerOpen(false); setOutcome(null); }}
          />
        </Suspense>
      )}
    </div>
  );
}

function Metric({ v, l, ok }: { v: string; l: string; ok?: boolean }) {
  return (
    <div className={`pt-metric${ok ? ' is-ok' : ''}`}>
      <div className="pt-metric-v">{v}</div>
      <div className="pt-metric-l">{l}</div>
    </div>
  );
}
