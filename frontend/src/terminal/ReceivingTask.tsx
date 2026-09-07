import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type CartonCard,
  type IdentifierType,
  type ProductCard,
  type ReceivingArrival,
  type ReceivingSessionDetail,
  type ScanSource,
} from '../modules/receiving/api';
import { detectCapabilities, freshOperationId } from '../modules/receiving-terminal/scan-source';
import { beepSuccess, beepError, beepInfo, beepDone, beepWarning } from '../modules/receiving-terminal/feedback';
import { cleanCode } from '../modules/receiving-terminal/validate';
import { buildScanContext, type ScanContext } from '../modules/receiving-terminal/scan-context';
import { matchCartonCard, matchProductCard } from '../modules/receiving/match';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import './receiving-task.css';

/**
 * RECEIVING — the ONE canonical receiving workspace (card-based rebuild).
 *
 * The CRM pushes two INDEPENDENT card types:
 *   PRODUCT CARD (Customer Arrival Card) and CARTON CARD (Shipment Card).
 * The receiving screen offers two real workflow ENTRIES — PRODUIT and CARTON.
 *
 * DEVICE-SIDE MATCHING is primary: the session downloads the expected card
 * data; a scan/OCR read is matched LOCALLY against the active lane's cards.
 * MATCH opens an explicit confirm step (CONFIRM only after the worker
 * presses it); MISMATCH is logged as a failure and NEVER confirms. The
 * backend stays the final authority: sync, persistence, state update,
 * duplicate-completion protection and the worker activity log.
 *
 * The two card sets are never merged: the PRODUIT lane only ever sees product
 * cards, the CARTON lane only ever sees carton cards.
 */

// Dual-scanner host (device-aware Software/Hardware selection; OCR reuse):
// camera / wedge / manual all funnel into the same local-matching pipeline.
const ReceivingScanner = lazy(() => import('../modules/receiving-terminal/ReceivingScanner'));

type Lane = 'PRODUCT' | 'CARTON';

type Review =
  | { kind: 'PRODUCT'; scan: string; source: ScanSource; card: ProductCard; startedAt: string; qty: number }
  | { kind: 'CARTON'; scan: string; source: ScanSource; card: CartonCard; matchedOn: string; startedAt: string };

type ScanOutcomeShape = { kind: 'ok' | 'bad' | 'info' | 'warn'; text: string; token: number };

function identifierTypeFor(source: ScanSource): IdentifierType {
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
  /** Active workflow lane — PRODUIT or CARTON (the two real entries). */
  const [lane, setLane] = useState<Lane | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [outcome, setOutcome] = useState<ScanOutcomeShape | null>(null);
  const [manual, setManual] = useState('');
  const [log, setLog] = useState<Array<{ t: string; text: string; kind: 'ok' | 'bad' | 'info' | 'warn' }>>([]);

  /** Keystroke timing buffers to classify wedge-scanner bursts. */
  const stamps = useRef<number[]>([]);

  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const push = useCallback((text: string, kind: 'ok' | 'bad' | 'info' | 'warn') => {
    setLog((l) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 40));
    setLastAction(text);
  }, [setLastAction]);

  /** Validation corpora for the guided scanner: known codes of the lane. */
  const corpus = useMemo(() => {
    const out = new Set<string>();
    const add = (v?: string | null) => {
      const c = cleanCode(v ?? '');
      if (c.length >= 2) out.add(c);
    };
    if (session) {
      if (lane === 'CARTON') {
        for (const c of session.cartonCards) {
          add(c.externalCartonId); add(c.qrCodeValue); add(c.barcodeValue); add(c.reference);
        }
      } else {
        for (const p of session.productCards) { add(p.sku); add(p.reference); }
      }
    }
    return [...out];
  }, [session, lane]);

  /**
   * PREFETCH: the session's expected card values, normalised ONCE, held in
   * memory for local expected matching — no per-frame/backend work inside the
   * recognition loop. The backend stays final authority afterwards.
   */
  const scanContext: ScanContext = useMemo(
    () =>
      buildScanContext({
        mode: lane === 'CARTON' ? 'CARTON' : 'PRODUCT',
        cartons: session?.cartonCards ?? [],
        products: session?.productCards ?? [],
      }),
    [session, lane],
  );

  /** Single place where an outcome is surfaced: banner + sound. */
  const report = useCallback((kind: 'ok' | 'bad' | 'info' | 'warn', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    setStatus({ text: kind === 'ok' ? 'ACCEPTED' : kind === 'bad' ? 'NOT ACCEPTED' : kind === 'warn' ? 'ATTENTION' : 'READY', kind });
    if (kind === 'ok') beepSuccess();
    else if (kind === 'bad') beepError();
    else if (kind === 'warn') beepWarning();
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
    api.session(active.id).then((s) => { setSession(s); if (!lane) setLane('CARTON'); }).catch(() => {});
  }, [ctx, session, lane]);

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
      setLane('CARTON');
      setReview(null);
      push(`session ${s.code} ${existing ? 'resumed' : 'started'}`, 'info');
      setStatus({ text: 'SESSION ACTIVE', kind: 'info' });
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not open receiving.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * THE receiving scan pipeline (camera / wedge / manual / OCR all land
   * here): normalise -> match locally against the ACTIVE LANE's cards ->
   * MATCH opens the explicit confirm step, MISMATCH is logged as a failure.
   */
  const onScannerDetected = useCallback(async (raw: string, source: ScanSource) => {
    const value = raw.trim();
    if (!value || !session || busy) return;
    if (!lane) {
      report('info', 'SELECT PRODUIT OR CARTON FIRST');
      return;
    }

    if (lane === 'PRODUCT') {
      const card = matchProductCard(value, session.productCards);
      if (!card) {
        // DEVICE MISMATCH — no product card matches: log the failure, confirm nothing.
        try {
          const s = await api.reportMismatch(session.id, {
            cardType: 'PRODUCT',
            identifier: value,
            identifierType: identifierTypeFor(source),
            source,
            startedAt: new Date().toISOString(),
          });
          setSession(s);
          report('bad', `${value} — NOT MATCHED TO ANY PRODUCT CARD`);
          push(`product ${value} mismatch logged`, 'bad');
        } catch (e: any) {
          const m = e?.response?.data?.message ?? 'the request failed — try again';
          report('bad', Array.isArray(m) ? m.join(', ') : String(m));
        }
        return;
      }
      if (card.received >= card.expected) {
        // Completed card — reject locally, nothing is written.
        report('bad', `${card.sku ?? card.reference} — CARD ALREADY COMPLETE`);
        push(`product ${card.sku ?? card.reference} rejected: card already complete`, 'bad');
        return;
      }
      setReview({ kind: 'PRODUCT', scan: value, source, card, startedAt: new Date().toISOString(), qty: 1 });
      report('ok', `${card.productName ?? card.sku} — PRODUCT MATCH, CONFIRM TO RECEIVE`);
      push(`product ${value} matched`, 'ok');
      return;
    }

    // CARTON lane
    const m = matchCartonCard(value, session.cartonCards);
    if (m.result === 'none') {
      try {
        const s = await api.reportMismatch(session.id, {
          cardType: 'CARTON',
          identifier: value,
          identifierType: identifierTypeFor(source),
          source,
          startedAt: new Date().toISOString(),
        });
        setSession(s);
        report('bad', `${value} — NOT MATCHED TO ANY CARTON CARD`);
        push(`carton ${value} mismatch logged`, 'bad');
      } catch (e: any) {
        const m2 = e?.response?.data?.message ?? 'the request failed — try again';
        report('bad', Array.isArray(m2) ? m2.join(', ') : String(m2));
      }
      return;
    }
    if (m.result === 'ambiguous') {
      const codes = m.cartons.map((c) => c.externalCartonId).join(' · ');
      report('warn', `${m.cartons.length} CARTONS MATCH THIS TRACKING — SCAN THE SPECIFIC CARTON (${codes})`);
      push(`tracking ${value} ambiguous: ${codes}`, 'warn');
      return;
    }
    if (m.result === 'all-received') {
      report('warn', `ALL CARTONS FOR THIS TRACKING ARE ALREADY RECEIVED`);
      push(`tracking ${value} all cartons already received`, 'warn');
      return;
    }
    if (m.card.status === 'RECEIVED') {
      report('bad', `${m.card.externalCartonId} — CARTON ALREADY RECEIVED`);
      push(`carton ${m.card.externalCartonId} rejected: already received`, 'bad');
      return;
    }
    setReview({ kind: 'CARTON', scan: value, source, card: m.card, matchedOn: m.matchedOn, startedAt: new Date().toISOString() });
    report('ok', `${m.card.externalCartonId} (${m.card.cartonNumber}/${m.card.totalCartons}) — CARTON MATCH, CONFIRM TO RECEIVE`);
    push(`carton ${value} matched`, 'ok');
  }, [session, busy, lane, report, push]);

  /** Explicit CONFIRM — the only path that writes a receipt (device match was advisory). */
  const confirmReview = useCallback(async () => {
    if (!session || !review || busy) return;
    setBusy(true);
    setStatus({ text: 'CONFIRMING', kind: 'info' });
    try {
      const isProduct = review.kind === 'PRODUCT';
      const s = isProduct
        ? await api.confirmProduct(session.id, {
          identifier: review.scan,
          identifierType: identifierTypeFor(review.source),
          quantity: Math.max(1, Math.floor(Number(review.qty) || 1)),
          source: review.source,
          operationId: freshOperationId(),
          startedAt: review.startedAt,
        })
        : await api.confirmCarton(session.id, {
          identifier: review.scan,
          identifierType: identifierTypeFor(review.source),
          source: review.source,
          operationId: freshOperationId(),
          startedAt: review.startedAt,
        });
      setSession(s);
      setReview(null);
      const f = s.flash;
      const t = s.tally;
      if (f?.kind === 'MATCH') {
        if (f.cardType === 'CARTON') {
          report('ok', `${f.carton?.externalCartonId ?? f.code} RECEIVED · cartons ${t?.receivedCartons ?? 0}/${t?.expectedCartons ?? 0}`);
          push(`carton ${f.carton?.externalCartonId ?? f.code} confirmed`, 'ok');
        } else {
          report('ok', `${f.code} +${isProduct ? Math.max(1, Math.floor(Number((review as any).qty) || 1)) : 1} · units ${t?.receivedUnits ?? 0}/${t?.expectedUnits ?? 0}`);
          push(`product ${f.code} confirmed`, 'ok');
        }
        return;
      }
      if (f?.kind === 'CARD_ALREADY_COMPLETE') {
        report('warn', `${f.code} — ${f.message ?? 'ALREADY COMPLETE'}`);
        push(`${f.code} rejected: already complete`, 'warn');
        return;
      }
      if (f?.kind === 'TRACKING_AMBIGUOUS') {
        const codes = (f.cartons ?? []).map((c: any) => c.externalCartonId).join(' · ');
        report('warn', `${f.message ?? 'TRACKING AMBIGUOUS'}${codes ? ` (${codes})` : ''}`);
        push(`tracking ambiguous: ${codes || f.code}`, 'warn');
        return;
      }
      report('bad', `${f?.code ?? review.scan} — ${f?.kind === 'WRONG_SHIPMENT' ? `WRONG SHIPMENT${f.shipment ? ` (${f.shipment.code})` : ''}` : f?.message ?? 'NOT ACCEPTED'}`);
      push(`${review.scan} rejected: ${f?.kind ?? 'error'}`, 'bad');
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'the request failed — try again';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      push(`error on ${review.scan}`, 'bad');
    } finally {
      setBusy(false);
    }
  }, [session, review, busy, report, push, setStatus]);

  function selectLane(l: Lane) {
    if (busy) return;
    setLane(l);
    setReview(null);
    setScannerOpen(true);
    setOutcome(null);
    setStatus({ text: l === 'PRODUCT' ? 'PRODUIT — PRODUCT VERIFICATION' : 'CARTON — CARTON VERIFICATION', kind: 'info' });
  }

  async function togglePause() {
    if (!session) return;
    setBusy(true);
    try {
      const s = session.status === 'PAUSED' ? await api.resume(session.id) : await api.pause(session.id);
      setSession(s);
      setReview(null);
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
      setReview(null);
      if (r.status === 'COMPLETED') { beepDone(); report('ok', 'SESSION COMPLETE'); }
      else { report('bad', 'CLOSED WITH DISCREPANCIES'); }
      push('receiving completed', 'ok');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Could not complete.');
    } finally { setBusy(false); }
  }

  /** Shared wedge-scanner classifier: fast burst = hardware gun, slow = human. */
  function wedgeAware(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') return true;
    if (e.key.length === 1) {
      stamps.current.push(Date.now());
      if (stamps.current.length > 64) stamps.current.shift();
    }
    return false;
  }

  function isBurst() {
    const s = stamps.current;
    const fast = s.length > 4 && (s[s.length - 1] - s[0]) / s.length < 40;
    stamps.current = [];
    return fast;
  }

  function onManualKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!wedgeAware(e)) return;
    e.preventDefault();
    const fast = isBurst();
    const value = manual;
    setManual('');
    void onScannerDetected(value, fast ? 'EXTERNAL_SCANNER' : 'MANUAL');
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
      {/* Session identity — who/what am I receiving. */}
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
          <button className="os-btn" onClick={() => { setSession(null); setLane(null); setReview(null); void loadArrivals(); }}>
            CLOSE
          </button>
        </div>
      </div>

      {error && <div className="rt-error">{error}</div>}

      {/* Progress — the numbers a receiving worker actually needs. */}
      <div className="rt-progress">
        <Metric label="CARTONS" v={`${tally?.receivedCartons ?? 0}/${tally?.expectedCartons ?? 0}`}
          ok={(tally?.receivedCartons ?? 0) >= (tally?.expectedCartons ?? 0) && (tally?.expectedCartons ?? 0) > 0} />
        <Metric label="UNITS" v={`${tally?.receivedUnits ?? 0}/${tally?.expectedUnits ?? 0}`}
          ok={(tally?.receivedUnits ?? 0) >= (tally?.expectedUnits ?? 0) && (tally?.expectedUnits ?? 0) > 0} />
        <Metric label="EXCEPTIONS" v={String(tally?.openDiscrepancies ?? 0)}
          bad={(tally?.openDiscrepancies ?? 0) > 0} />
      </div>

      {/* WORKFLOW ENTRIES — PRODUIT and CARTON are the two real entries. */}
      {!done && (
        <div className="rt-lanes">
          <button
            type="button"
            className={`os-btn os-btn--primary rt-lane${lane === 'PRODUCT' ? ' is-active' : ''}`}
            disabled={paused || busy}
            onClick={() => selectLane('PRODUCT')}
          >
            <span className="rt-lane-t">PRODUIT</span>
            <span className="rt-lane-s">product verification</span>
          </button>
          <button
            type="button"
            className={`os-btn os-btn--primary rt-lane${lane === 'CARTON' ? ' is-active' : ''}`}
            disabled={paused || busy}
            onClick={() => selectLane('CARTON')}
          >
            <span className="rt-lane-t">CARTON</span>
            <span className="rt-lane-s">carton verification</span>
          </button>
        </div>
      )}

      {/* Scan input for the active lane (manual fallback — same pipeline). */}
      {!done && lane && (
        <div className="rt-manual">
          <label className="os-label" htmlFor="rt-input">
            {lane === 'PRODUCT' ? 'SCAN OR TYPE PRODUCT (SKU / REFERENCE / QR / BARCODE / OCR)' : 'SCAN OR TYPE CARTON (REF / TRACKING / QR / BARCODE / OCR)'}
          </label>
          <div className="os-row">
            <input
              id="rt-input"
              className="os-input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={onManualKey}
              placeholder={lane === 'PRODUCT' ? 'SKU / reference then Enter' : 'CTN-… / tracking then Enter'}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy || paused}
            />
            <button
              className="os-btn"
              disabled={busy || paused || !manual.trim()}
              onClick={() => { const v = manual; setManual(''); void onScannerDetected(v, 'MANUAL'); }}
            >
              SCAN
            </button>
            <button className="os-btn" disabled={busy || paused} onClick={() => setScannerOpen((o) => !o)}>
              {scannerOpen ? 'CLOSE SCANNER' : 'OPEN SCANNER'}
            </button>
          </div>
        </div>
      )}

      {/* DEVICE-SIDE MATCH RESULT — explicit confirm (no auto-commit). */}
      {review && (
        <div className={`rt-verify rt-verify--${review.kind === 'PRODUCT' ? 'product' : 'carton'}`}>
          <div className="rt-verify-head">
            <span className="os-tag os-tag--ok">MATCH</span>
            {review.kind === 'CARTON' && review.matchedOn === 'TRACKING NUMBER' && (
              <span className="os-tag os-tag--info">MATCHED ON TRACKING NUMBER</span>
            )}
            <span className="os-muted os-mono">{review.scan}</span>
          </div>
          {review.kind === 'PRODUCT' ? (
            <div className="rt-verify-body">
              <div className="rt-verify-name">{review.card.productName ?? review.card.sku ?? review.card.reference}</div>
              <div className="os-muted os-mono">{review.card.sku ?? '—'}{review.card.reference && review.card.reference !== review.card.sku ? ` · ${review.card.reference}` : ''}</div>
              <div className="rt-verify-nums">
                <span className="os-mono">EXP {review.card.expected}</span>
                <span className="os-mono">REC {review.card.received}</span>
                <span className="os-mono">LEFT {review.card.remaining}</span>
              </div>
            </div>
          ) : (
            <div className="rt-verify-body">
              <div className="rt-verify-name">{review.card.externalCartonId}</div>
              <div className="os-muted os-mono">
                CARTON {review.card.cartonNumber}/{review.card.totalCartons}
                {review.card.reference ? ` · REF ${review.card.reference}` : ''}
                {review.card.trackingNumber ? ` · TRACK ${review.card.trackingNumber}` : ''}
              </div>
            </div>
          )}
          <div className="os-row rt-verify-actions">
            {review.kind === 'PRODUCT' && (
              <input
                className="os-input rt-qty"
                type="number"
                min={1}
                value={String(review.qty)}
                onChange={(e) => setReview({ ...review, qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                disabled={busy}
                aria-label="Quantity"
              />
            )}
            <button
              type="button"
              className="os-btn os-btn--primary"
              disabled={busy}
              onClick={() => void confirmReview()}
            >
              {busy ? 'CONFIRMING…' : 'CONFIRM'}
            </button>
            <button
              type="button"
              className="os-btn"
              disabled={busy}
              onClick={() => { setReview(null); setOutcome(null); setStatus({ text: 'READY', kind: 'info' }); }}
            >
              KEEP SCANNING
            </button>
          </div>
        </div>
      )}

      {/* Inline outcome (camera scanner shows its own too). */}
      {outcome && !scannerOpen && (
        <div key={outcome.token} className={`rt-outcome rt-outcome--${outcome.kind}`}>
          {outcome.kind === 'ok' ? '✓ ' : outcome.kind === 'bad' ? '✕ ' : outcome.kind === 'warn' ? '⚠ ' : ''}{outcome.text}
        </div>
      )}

      <div className="rt-cols">
        <section className="os-card">
          <h2 className="os-card-title">Carton Cards · {session.cartonCards.length}</h2>
          <div className="rt-cartons">
            {session.cartonCards.map((c) => {
              const received = c.status === 'RECEIVED';
              return (
                <div key={c.id} className={`rt-carton${received ? ' is-done' : ''}`}>
                  <span>{received ? '✓' : '○'}</span>
                  <span className="os-mono">{c.externalCartonId}</span>
                  <span className="os-muted">{c.cartonNumber}/{c.totalCartons}</span>
                </div>
              );
            })}
            {session.cartonCards.length === 0 && <div className="os-muted">No carton cards.</div>}
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

      {/* Product cards — supporting info for the PRODUIT lane. */}
      {session.productCards.length > 0 && (
        <section className="os-card">
          <h2 className="os-card-title">Product Cards · {session.productCards.length} lines</h2>
          <div className="rt-products">
            <table className="os-table">
              <thead>
                <tr><th>SKU</th><th>Name</th><th>Category</th><th>Expected</th><th>Received</th><th>Status</th></tr>
              </thead>
              <tbody>
                {session.productCards.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.sku ?? p.reference ?? '—'}</td>
                    <td>{p.productName ?? '—'}</td>
                    <td>
                      {p.categoryStatus === 'CONFIRMED' && p.category
                        ? (
                          <span className="os-tag os-tag--ok">
                            {p.category}{p.subcategory ? ` / ${p.subcategory}` : ''}
                          </span>
                        )
                        : (
                          <span className="os-tag os-tag--warn">
                            {p.category ? `${p.category} · NEEDS REVIEW` : 'NEEDS REVIEW'}
                          </span>
                        )}
                    </td>
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

      {/* Open discrepancies — visible, not buried. */}
      {openDiscrepancies.length > 0 && (
        <section className="os-card rt-disc">
          <h2 className="os-card-title">Exceptions · {openDiscrepancies.length} open</h2>
          {openDiscrepancies.map((d) => (
            <div key={d.id} className="rt-disc-item">
              <span className="os-tag os-tag--err">{d.type.replace(/_/g, ' ')}</span>
              <span className="os-muted">{d.reason ?? '—'}</span>
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

      {/* SCANNER WORKSPACE for the active lane — dual scanner host (software + hardware, OCR reuse). */}
      {scannerOpen && lane && (
        <Suspense fallback={<div className="rt-scanner-loading">STARTING SCANNER…</div>}>
          <ReceivingScanner
            title={`RECEIVING · ${lane === 'PRODUCT' ? 'PRODUIT' : 'CARTON'} · ${session.code}`}
            enableOcr={ocrAllowed}
            mode={lane === 'CARTON' ? 'CARTON' : 'PRODUCT'}
            onModeChange={(m) => setLane(m === 'CARTON' ? 'CARTON' : 'PRODUCT')}
            outcome={outcome}
            corpus={corpus}
            scanContext={scanContext}
            onDetected={(value, source) => { void onScannerDetected(value, source); }}
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
