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
 * RECEIVING — the ONE canonical receiving workspace (consolidation spec §1-§22).
 *
 * Everything the two legacy implementations could do lives HERE now:
 *   arrival selection + resume · carton scanning (camera/wedge/manual) ·
 *   product unit receiving with quantity · pause/resume · expected products ·
 *   discrepancies · activity · complete — flat hierarchy, no box-in-box.
 *
 * The backend stays the single source of truth: nothing counts as received
 * until the API says so, and every input path funnels through ONE submit
 * pipeline per entity (cartons / products).
 */

const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

type Outcome = ScanOutcome;
type ScanMode = 'CARTON' | 'PRODUCT';

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
  const [scanMode, setScanMode] = useState<ScanMode>('CARTON');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manual, setManual] = useState('');
  const [productSku, setProductSku] = useState('');
  const [productQty, setProductQty] = useState('1');
  const [log, setLog] = useState<Array<{ t: string; text: string; kind: 'ok' | 'bad' | 'info' }>>([]);

  /** Keystroke timing buffers to classify wedge-scanner bursts (§11). */
  const stamps = useRef<number[]>([]);
  const productStamps = useRef<number[]>([]);

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

  /** THE carton submission path — camera, wedge scanner and manual all land here. */
  const submitCarton = useCallback(async (raw: string, source: ScanSource) => {
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
        const t = committed.tally;
        report('ok', `${cartonId} RECEIVED · cartons ${t?.receivedCartons ?? 0}/${t?.expectedCartons ?? 0}`);
        push(`carton ${cartonId} received`, 'ok');
        return;
      }

      setSession(scanned);
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

  /**
   * THE product submission path (migrated from the legacy terminal).
   * Each accepted SKU moves receivedUnits forward; unexpected SKUs are
   * recorded by the backend as discrepancies — never silently dropped.
   */
  const submitProduct = useCallback(async (raw: string, qty: number, source: ScanSource) => {
    const value = raw.trim();
    const n = Math.max(1, Math.floor(Number(qty) || 1));
    if (!value || !session || busy) return;
    setBusy(true);
    setStatus({ text: 'SUBMITTING', kind: 'info' });
    try {
      const s = await api.receiveProduct(session.id, value, n, source, freshOperationId());
      setSession(s);
      const f = s.flash;
      if (f?.kind === 'UNEXPECTED_PRODUCT') {
        report('bad', `${value} — NOT ON EXPECTED LIST`);
        push(`product ${value} unexpected — discrepancy recorded`, 'bad');
      } else {
        const t = s.tally;
        report('ok', `${value} +${n} · units ${t?.receivedUnits ?? 0}/${t?.expectedUnits ?? 0}`);
        push(`product ${value} +${n} received`, 'ok');
      }
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      push(`error on ${value}`, 'bad');
    } finally {
      setBusy(false);
    }
  }, [session, busy, report, push, setStatus]);

  /** One detection pipeline routed by the scanner's current work mode. */
  const onScannerDetected = useCallback((value: string, source: ScanSource) => {
    if (scanMode === 'PRODUCT') void submitProduct(value, 1, source);
    else void submitCarton(value, source);
  }, [scanMode, submitCarton, submitProduct]);

  async function togglePause() {
    if (!session) return;
    setBusy(true);
    try {
      const s = session.status === 'PAUSED' ? await api.resume(session.id) : await api.pause(session.id);
      setSession(s);
      const paused = s.status === 'PAUSED';
      report('info', paused ? 'SESSION PAUSED' : 'SESSION RESUMED');
      push(paused ? 'session paused' : 'session resumed', 'info');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not change session state.');
    } finally { setBusy(false); }
  }

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

  /** Shared wedge-scanner classifier: fast burst = hardware gun, slow = human. */
  function wedgeAware(
    stampsBuf: React.MutableRefObject<number[]>,
    e: React.KeyboardEvent<HTMLInputElement>,
  ) {
    if (e.key === 'Enter') return true;
    if (e.key.length === 1) {
      stampsBuf.current.push(Date.now());
      if (stampsBuf.current.length > 64) stampsBuf.current.shift();
    }
    return false;
  }

  function isBurst(stampsBuf: React.MutableRefObject<number[]>) {
    const s = stampsBuf.current;
    const fast = s.length > 4 && (s[s.length - 1] - s[0]) / s.length < 40;
    stampsBuf.current = [];
    return fast;
  }

  function onCartonKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!wedgeAware(stamps, e)) return;
    e.preventDefault();
    const fast = isBurst(stamps);
    const value = manual;
    setManual('');
    void submitCarton(value, fast ? 'EXTERNAL_SCANNER' : 'MANUAL');
  }

  function onProductKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!wedgeAware(productStamps, e)) return;
    e.preventDefault();
    const fast = isBurst(productStamps);
    const value = productSku;
    const qty = Number(productQty) || 1;
    setProductSku('');
    setProductQty('1');
    void submitProduct(value, qty, fast ? 'EXTERNAL_SCANNER' : 'MANUAL');
  }

  const tally = session?.tally;
  const paused = session?.status === 'PAUSED';
  const done = session && ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'].includes(session.status);
  const openDiscrepancies = session?.discrepancies?.filter((d) => d.status === 'OPEN') ?? [];

  // ---------- ARRIVAL SELECTION ----------
  if (!session) {
    return (
      <div className="rt-pick">
        <h1 className="rt-h1">RECEIVING</h1>
        <p className="os-muted">Select an arrival to start or resume receiving.</p>
        {error && (
          <div className="rt-error">
            {error}
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="os-btn"
                disabled={loading}
                onClick={() => { setError(null); void loadArrivals(); }}
              >
                ↻ RETRY
              </button>
            </div>
          </div>
        )}
        {loading ? (
          <div className="os-empty">loading arrivals…</div>
        ) : error ? null : arrivals.length === 0 ? (
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

  // ---------- RECEIVING SESSION (the operational workspace) ----------
  return (
    <div className="rt">
      {/* Session identity — who/what am I receiving (§5). */}
      <div className="rt-bar">
        <div className="rt-id">
          <span className="rt-session">{session.code}</span>
          <span className="os-muted"> · {session.arrival.customerName}</span>
          <span className="rt-id-sub os-muted os-mono">
            {session.arrival.code}{session.arrival.storeName ? ` · ${session.arrival.storeName}` : ''}
          </span>
          {paused && <span className="os-tag os-tag--warn">PAUSED</span>}
        </div>
        <div className="os-row">
          {!done && (
            <button className="os-btn" disabled={busy} onClick={togglePause}>
              {paused ? 'RESUME' : 'PAUSE'}
            </button>
          )}
          <button className="os-btn" onClick={() => { setSession(null); void loadArrivals(); }}>
            CLOSE
          </button>
        </div>
      </div>

      {error && <div className="rt-error">{error}</div>}

      {/* Progress — the numbers a receiving worker actually needs (§4/§5). */}
      <div className="rt-progress">
        <Metric label="CARTONS" v={`${tally?.receivedCartons ?? 0}/${tally?.expectedCartons ?? 0}`}
          ok={(tally?.receivedCartons ?? 0) >= (tally?.expectedCartons ?? 0) && (tally?.expectedCartons ?? 0) > 0} />
        <Metric label="UNITS" v={`${tally?.receivedUnits ?? 0}/${tally?.expectedUnits ?? 0}`}
          ok={(tally?.receivedUnits ?? 0) >= (tally?.expectedUnits ?? 0) && (tally?.expectedUnits ?? 0) > 0} />
        <Metric label="EXCEPTIONS" v={String(tally?.openDiscrepancies ?? 0)}
          bad={(tally?.openDiscrepancies ?? 0) > 0} />
      </div>

      {/* PRIMARY ACTION — visually dominant (§5). */}
      {!done && (
        <button
          className="os-btn os-btn--primary rt-scan-big"
          disabled={paused || busy}
          onClick={() => { setScanMode('CARTON'); setScannerOpen(true); }}
        >
          OPEN SCANNER
        </button>
      )}

      {/* Manual fallback — always available (§28), same backend path. */}
      {!done && (
        <div className="rt-manual">
          <label className="os-label" htmlFor="rt-input">SCAN OR TYPE CARTON</label>
          <div className="os-row">
            <input
              id="rt-input"
              className="os-input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={onCartonKey}
              placeholder="CTN-… then Enter"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy || paused}
            />
            <button
              className="os-btn"
              disabled={busy || paused || !manual.trim()}
              onClick={() => { const v = manual; setManual(''); void submitCarton(v, 'MANUAL'); }}
            >
              ENTER
            </button>
          </div>
        </div>
      )}

      {/* Product unit receiving (migrated from the legacy terminal). */}
      {!done && (
        <div className="rt-manual">
          <label className="os-label" htmlFor="rt-product">SCAN OR TYPE PRODUCT</label>
          <div className="os-row">
            <input
              id="rt-product"
              className="os-input"
              value={productSku}
              onChange={(e) => setProductSku(e.target.value)}
              onKeyDown={onProductKey}
              placeholder="SKU / reference then Enter"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy || paused}
            />
            <input
              className="os-input rt-qty"
              type="number"
              min={1}
              value={productQty}
              onChange={(e) => setProductQty(e.target.value)}
              disabled={busy || paused}
              aria-label="Quantity"
            />
            <button
              className="os-btn"
              disabled={busy || paused || !productSku.trim()}
              onClick={() => {
                const v = productSku; const q = Number(productQty) || 1;
                setProductSku(''); setProductQty('1');
                void submitProduct(v, q, 'MANUAL');
              }}
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

      {/* Expected products — supporting info (migrated). */}
      {(session.products ?? []).length > 0 && (
        <section className="os-card">
          <h2 className="os-card-title">Products · {session.products.length} lines</h2>
          <div className="rt-products">
            <table className="os-table">
              <thead>
                <tr><th>SKU</th><th>Name</th><th>Expected</th><th>Received</th><th>Status</th></tr>
              </thead>
              <tbody>
                {session.products.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.sku ?? p.reference ?? '—'}</td>
                    <td>{p.productName ?? '—'}</td>
                    <td>{p.expected}</td>
                    <td>{p.received}</td>
                    <td><span className={`os-tag ${p.status === 'RECEIVED' ? 'os-tag--ok' : p.status === 'EXPECTED' ? 'os-tag--muted' : 'os-tag--warn'}`}>{p.status.replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Open discrepancies — visible, not buried (migrated). */}
      {openDiscrepancies.length > 0 && (
        <section className="os-card rt-disc">
          <h2 className="os-card-title">Exceptions · {openDiscrepancies.length} open</h2>
          {openDiscrepancies.map((d) => (
            <div key={d.id} className="rt-disc-item">
              <span className="os-tag os-tag--err">{d.type.replace(/_/g, ' ')}</span>
              <span className="os-muted">{d.reason ?? d.sku ?? d.cartonCode ?? '—'}</span>
            </div>
          ))}
        </section>
      )}

      {!done && (
        <div className="rt-finish">
          <button className="os-btn" disabled={busy || paused} onClick={complete}>COMPLETE RECEIVING</button>
        </div>
      )}
      {done && <div className="rt-done">SESSION {session.status.replace(/_/g, ' ')}</div>}

      {/* SCANNER WORK MODE — the updated full-screen experience only (§6/§7). */}
      {scannerOpen && (
        <Suspense fallback={<div className="rt-scanner-loading">STARTING SCANNER…</div>}>
        <ContinuousScanner
          title={`RECEIVING · ${session.code}`}
          enableOcr={ocrAllowed}
          mode={scanMode}
          onModeChange={setScanMode}
          outcome={outcome}
          onDetected={onScannerDetected}
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
