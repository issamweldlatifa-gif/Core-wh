import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ReceivingArrival, type ReceivingSessionDetail } from '../modules/receiving/api';
import type { ScanOutcome } from '../modules/receiving-terminal/ContinuousScanner';
import {
  detectCapabilities,
  freshOperationId,
  type ScanSource,
} from '../modules/receiving-terminal/scan-source';
import { beepSuccess, beepError, beepInfo, beepDone } from '../modules/receiving-terminal/feedback';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import './receiving-task.css';

/**
 * The scanner pulls in ZXing (and, on demand, Tesseract). Loading it lazily
 * keeps the initial terminal download small on warehouse phones — it is only
 * fetched when the worker actually opens the camera.
 */
const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

/**
 * Receiving Terminal (spec §12/§13/§16/§24-§29).
 *
 * A full-screen worker workspace, not an admin widget. The workflow is
 * identical whatever produced the code — camera, wedge scanner or keyboard
 * (§11) — because every path funnels through `submitCode`.
 *
 * The backend is the source of truth: a carton is only shown as RECEIVED
 * after the API accepts it (§25).
 */

type Outcome = ScanOutcome;

function scanTypeFor(source: ScanSource): 'QR' | 'BARCODE' | 'MANUAL' {
  return source === 'CAMERA' ? 'QR' : source === 'EXTERNAL_SCANNER' ? 'BARCODE' : 'MANUAL';
}

export default function ReceivingTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const caps = useMemo(() => detectCapabilities(), []);

  const [arrivals, setArrivals] = useState<ReceivingArrival[]>([]);
  const [session, setSession] = useState<ReceivingSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manual, setManual] = useState('');
  const [log, setLog] = useState<Array<{ t: string; text: string; kind: 'ok' | 'bad' | 'info' }>>([]);

  const manualRef = useRef<HTMLInputElement>(null);
  /** Keystroke timing buffer to classify wedge-scanner bursts (§11). */
  const stamps = useRef<number[]>([]);

  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const push = useCallback((text: string, kind: 'ok' | 'bad' | 'info') => {
    setLog((l) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 40));
    setLastAction(text);
  }, [setLastAction]);

  /** Single place where an outcome is surfaced: banner + sound (§26/§27). */
  const report = useCallback((kind: 'ok' | 'bad' | 'info', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    setStatus({ text: kind === 'ok' ? 'ACCEPTED' : kind === 'bad' ? 'NOT ACCEPTED' : 'READY', kind });
    if (kind === 'ok') beepSuccess();
    else if (kind === 'bad') beepError();
    else beepInfo();
  }, [setStatus]);

  const loadArrivals = useCallback(async () => {
    setLoading(true);
    try {
      setArrivals(await api.arrivals());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Failed to load arrivals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadArrivals(); }, [loadArrivals]);

  // Resume an in-flight session automatically so a refresh never loses work.
  useEffect(() => {
    const active = ctx?.activeSession;
    if (!active || session) return;
    api.session(active.id).then(setSession).catch(() => {});
  }, [ctx, session]);

  async function openArrival(a: ReceivingArrival) {
    setBusy(true); setError(null);
    try {
      const existing = await api.active(a.code);
      const s = existing ?? await api.start(a.code, {
        deviceType: caps.deviceType,
        deviceName: caps.userAgent.slice(0, 80),
        scanSource: caps.cameraScanningSupported ? 'CAMERA' : 'EXTERNAL_SCANNER',
      });
      setSession(s);
      push(`session ${s.code} ${existing ? 'resumed' : 'started'}`, 'info');
      setStatus({ text: 'SESSION ACTIVE', kind: 'info' });
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not open receiving.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * The ONE submission path (§11/§24/§25).
   * Camera, wedge scanner and manual entry all land here, and nothing is
   * treated as received until the backend says so.
   */
  const submitCode = useCallback(async (raw: string, source: ScanSource) => {
    const value = raw.trim();
    if (!value || !session || busy) return;
    setBusy(true);
    setStatus({ text: 'SUBMITTING', kind: 'info' });
    try {
      const scanned = await api.scanCarton(
        session.id, value, scanTypeFor(source), freshOperationId(), source,
      );
      const f = scanned.flash;

      if (f?.kind === 'CARTON_IDENTIFIED') {
        // Identified -> commit. Auto-submit, no button press (§24).
        const cartonId = f.carton?.externalCartonId ?? f.carton?.id;
        const committed = await api.receiveCarton(session.id, cartonId, freshOperationId(), source);
        setSession(committed);
        report('ok', `${cartonId} RECEIVED`);
        push(`carton ${cartonId} received`, 'ok');
        return;
      }

      setSession(scanned);
      // Explicit, readable rejection reasons (§27).
      const why =
        f?.kind === 'UNKNOWN_CARTON' ? 'UNKNOWN REFERENCE'
        : f?.kind === 'DUPLICATE_CARTON' ? 'ALREADY RECEIVED'
        : f?.kind === 'WRONG_SHIPMENT' ? 'WRONG SHIPMENT'
        : 'NOT ACCEPTED';
      report('bad', `${value} — ${why}`);
      push(`${value} rejected: ${why}`, 'bad');
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      push(`error on ${value}`, 'bad');
    } finally {
      setBusy(false);
    }
  }, [session, busy, report, push, setStatus]);

  async function complete() {
    if (!session) return;
    setBusy(true);
    try {
      const r = await api.complete(session.id);
      setSession(r);
      if (r.status === 'COMPLETED') { beepDone(); report('ok', 'SESSION COMPLETE'); }
      else { report('bad', 'CLOSED WITH DISCREPANCIES'); }
      push('receiving completed', 'ok');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not complete.');
    } finally { setBusy(false); }
  }

  function onManualKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // A fast burst is a hardware scanner, slow typing is a human (§11).
      const s = stamps.current;
      const fast = s.length > 4 && (s[s.length - 1] - s[0]) / s.length < 40;
      stamps.current = [];
      const value = manual;
      setManual('');
      void submitCode(value, fast ? 'EXTERNAL_SCANNER' : 'MANUAL');
      return;
    }
    if (e.key.length === 1) {
      stamps.current.push(Date.now());
      if (stamps.current.length > 64) stamps.current.shift();
    }
  }

  const tally = session?.tally;
  const done = session && ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'].includes(session.status);

  // ---------- ARRIVAL PICKER ----------
  if (!session) {
    return (
      <div className="rt-pick">
        <h1 className="rt-h1">RECEIVING</h1>
        <p className="os-muted">Select an arrival to start or resume receiving.</p>
        {error && <div className="rt-error">{error}</div>}
        {loading ? (
          <div className="os-empty">loading arrivals…</div>
        ) : arrivals.length === 0 ? (
          <div className="os-empty">No arrivals awaiting receiving.</div>
        ) : (
          <div className="rt-arrivals">
            {arrivals.map((a) => (
              <button key={a.id} className="rt-arrival" disabled={busy} onClick={() => openArrival(a)}>
                <span className="rt-arrival-code">{a.code}</span>
                <span className="rt-arrival-cust">{a.customerName}</span>
                <span className="os-muted">{a.cartons} cartons · {a.units} units</span>
                <span className={`os-tag ${a.status === 'EXPECTED' ? 'os-tag--info' : 'os-tag--warn'}`}>
                  {a.status === 'EXPECTED' ? 'START' : 'RESUME'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---------- ACTIVE SESSION ----------
  return (
    <div className="rt">
      <div className="rt-bar">
        <div>
          <span className="rt-session">{session.code}</span>
          <span className="os-muted"> · {session.arrival.customerName}</span>
        </div>
        <div className="os-row">
          {!done && (
            <button className="os-btn os-btn--primary rt-scan-btn" onClick={() => setScannerOpen(true)}>
              OPEN SCANNER
            </button>
          )}
          <button className="os-btn" onClick={() => { setSession(null); void loadArrivals(); }}>
            CLOSE
          </button>
        </div>
      </div>

      {error && <div className="rt-error">{error}</div>}

      {/* Progress — the numbers a receiving worker actually needs (§4). */}
      <div className="rt-progress">
        <Metric label="CARTONS" v={`${tally?.receivedCartons ?? 0}/${tally?.expectedCartons ?? 0}`}
          ok={(tally?.receivedCartons ?? 0) >= (tally?.expectedCartons ?? 0)} />
        <Metric label="UNITS" v={`${tally?.receivedUnits ?? 0}/${tally?.expectedUnits ?? 0}`} />
        <Metric label="EXCEPTIONS" v={String(tally?.openDiscrepancies ?? 0)}
          bad={(tally?.openDiscrepancies ?? 0) > 0} />
      </div>

      {/* Manual fallback — always available (§28), same backend path. */}
      {!done && (
        <div className="rt-manual">
          <label className="os-label" htmlFor="rt-input">SCAN OR TYPE CARTON</label>
          <div className="os-row">
            <input
              id="rt-input"
              ref={manualRef}
              className="os-input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={onManualKey}
              placeholder="CTN-… then Enter"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
            />
            <button
              className="os-btn"
              disabled={busy || !manual.trim()}
              onClick={() => { const v = manual; setManual(''); void submitCode(v, 'MANUAL'); }}
            >
              ENTER
            </button>
          </div>
        </div>
      )}

      {/* Inline outcome for non-camera input (the camera shows its own). */}
      {outcome && !scannerOpen && (
        <div key={outcome.token} className={`rt-outcome rt-outcome--${outcome.kind}`}>
          {outcome.kind === 'ok' ? '✓ ' : outcome.kind === 'bad' ? '✕ ' : ''}{outcome.text}
        </div>
      )}

      <div className="rt-cols">
        <section className="os-card">
          <h2 className="os-card-title">Cartons</h2>
          <div className="rt-cartons">
            {(session.cartons ?? []).map((c) => {
              const received = c.status === 'RECEIVED';
              return (
                <div key={c.id} className={`rt-carton${received ? ' is-done' : ''}`}>
                  <span>{received ? '✓' : '○'}</span>
                  <span className="os-mono">{c.externalCartonId}</span>
                </div>
              );
            })}
            {session.cartons.length === 0 && <div className="os-muted">No cartons declared.</div>}
          </div>
        </section>

        <section className="os-card">
          <h2 className="os-card-title">Activity</h2>
          <div className="rt-log">
            {log.length === 0 && <div className="os-muted">No activity yet.</div>}
            {log.map((l, i) => (
              <div key={i} className={`rt-log-item ${l.kind}`}>
                <span className="os-muted">{l.t}</span> {l.text}
              </div>
            ))}
          </div>
        </section>
      </div>

      {!done && (
        <div className="rt-finish">
          <button className="os-btn" disabled={busy} onClick={complete}>COMPLETE RECEIVING</button>
        </div>
      )}
      {done && <div className="rt-done">SESSION {session.status.replace(/_/g, ' ')}</div>}

      {scannerOpen && (
        <Suspense fallback={<div className="rt-scanner-loading">STARTING SCANNER…</div>}>
        <ContinuousScanner
          title={`RECEIVING · ${session.code}`}
          enableOcr={ocrAllowed}
          outcome={outcome}
          onDetected={(value, source) => { void submitCode(value, source); }}
          onClose={() => {
            setScannerOpen(false);
            setOutcome(null);
            setStatus({ text: 'SESSION ACTIVE', kind: 'info' });
          }}
        />
        </Suspense>
      )}
    </div>
  );
}

function Metric({ label, v, ok, bad }: { label: string; v: string; ok?: boolean; bad?: boolean }) {
  return (
    <div className={`rt-metric${ok ? ' is-ok' : ''}${bad ? ' is-bad' : ''}`}>
      <div className="rt-metric-v">{v}</div>
      <div className="rt-metric-l">{label}</div>
    </div>
  );
}
