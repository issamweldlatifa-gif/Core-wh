import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  api as receivingApi,
  type CartonCard,
  type Flash,
  type ProductCard,
  type ReceivingHome as ReceivingHomeData,
  type ScanSource,
  type IdentifierType,
} from '../modules/receiving/api';
import { matchCartonCard, matchProductCard, normalizeTerm } from '../modules/receiving/match';
import { detectCapabilities, freshOperationId } from '../modules/receiving-terminal/scan-source';
import { beepError, beepInfo, beepSuccess, beepWarning } from '../modules/receiving-terminal/feedback';
import { cleanCode } from '../modules/receiving-terminal/validate';
import { buildScanContext, type ScanContext } from '../modules/receiving-terminal/scan-context';
import { useTerminalUi } from './WorkerShell';
import './receiving-home.css';

/**
 * RECEIVING HOME — the worker entry for the card-based receiving rebuild.
 *
 * The CRM pushes two INDEPENDENT card types to the Admin Web, the backend
 * auto-dispatches them to the worker, and the worker opens RECEIVING to find
 * two tiles already populated:
 *
 *   ┌──────────── PRODUIT ───────────┐   ┌──────────── CARTON ───────────┐
 *   │ Cards: N   [SCAN]              │   │ Cards: N   [SCAN]             │
 *   └────────────────────────────────┘   └────────────────────────────────┘
 *
 * The counter is the number of available cards of that type (live from the
 * backend, no mock data). The lists below each tile show what arrived
 * (reference / tracking) for information only — the worker NEVER picks a
 * card. SCAN opens the lane-specific scanner; matching is device-side:
 *
 *   PRODUCT scanner → matchProductCard → CONFIRM → /receiving/home/product
 *   CARTON  scanner → matchCartonCard  → CONFIRM → /receiving/home/carton
 *
 * The two lanes are strictly separated: the product scanner only ever sees
 * product cards and only calls the product endpoint (and vice versa). A
 * MISMATCH confirms nothing, completes nothing and is logged
 * (/receiving/home/mismatch). The backend is the final authority.
 */

// Dual-scanner host (device-aware Software/Hardware selection; OCR reuse —
// the existing scanner stack is untouched).
const ReceivingScanner = lazy(() => import('../modules/receiving-terminal/ReceivingScanner'));

type Lane = 'PRODUCT' | 'CARTON';

/**
 * Browser/device notification for a newly dispatched card (rebuild §17).
 * Uses the existing web Notification API (phone + desktop); when permission
 * is absent the in-app counter + beep still convey the arrival, so this never
 * blocks the flow. Requested lazily the first time the home is used.
 */
function notify(title: string, body: string) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const show = () => {
      try { new window.Notification(title, { body, tag: 'ayrovi-receiving' }); } catch { /* ignore */ }
    };
    if (Notification.permission === 'granted') show();
    else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
  } catch { /* notifications are best-effort */ }
}

type Review =
  | { lane: 'PRODUCT'; card: ProductCard; identifier: string; source: ScanSource; identifierType: IdentifierType; startedAt: string }
  | { lane: 'CARTON'; card: CartonCard; matchedOn: string; identifier: string; source: ScanSource; identifierType: IdentifierType; startedAt: string };

const POLL_MS = 20_000;

export default function ReceivingHome() {
  const navigate = useNavigate();
  const { setStatus, setLastAction, reload } = useTerminalUi();
  const caps = useMemo(() => detectCapabilities(), []);

  const [home, setHome] = useState<ReceivingHomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await receivingApi.home();
      setHome(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load receiving cards.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Real-time / automatic sync: the feed is refreshed on an interval and on
  // focus/reconnect, so a newly dispatched card updates the counters WITHOUT
  // any manual refresh (the existing sync mechanism — polled worker feed).
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', () => void load());
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', () => void load());
    };
  }, [load]);

  // Counter-change feedback (the worker hears + sees that a card arrived even
  // while on the home screen) — mirrors the native notification behaviour.
  const prevCounts = useRef<{ p: number; c: number } | null>(null);
  useEffect(() => {
    if (!home) return;
    const prev = prevCounts.current;
    prevCounts.current = { p: home.productCardsPending, c: home.cartonCardsPending };
    if (prev && home.productCardsPending > prev.p) {
      beepInfo();
      setLastAction?.('New product card received');
      notify('New Product Card received', `${home.productCardsPending} product card(s) waiting.`);
    }
    if (prev && home.cartonCardsPending > prev.c) {
      beepInfo();
      setLastAction?.('New carton card received');
      notify('New Carton Card received', `${home.cartonCardsPending} carton card(s) waiting.`);
    }
  }, [home, setLastAction]);

  /** Validation corpora + scan context for the guided scanner (lane only). */
  const corpus = useMemo(() => {
    const out = new Set<string>();
    const add = (v?: string | null) => { const c = cleanCode(v ?? ''); if (c.length >= 2) out.add(c); };
    if (lane === 'CARTON') {
      for (const c of home?.cartonCards ?? []) { add(c.externalCartonId); add(c.qrCodeValue); add(c.barcodeValue); add(c.reference); add(c.trackingNumber); }
    } else if (lane === 'PRODUCT') {
      for (const p of home?.productCards ?? []) { add(p.sku); add(p.reference); }
    }
    return [...out];
  }, [home, lane]);

  const scanContext: ScanContext = useMemo(
    () =>
      buildScanContext({
        mode: lane === 'CARTON' ? 'CARTON' : 'PRODUCT',
        cartons: lane === 'CARTON' ? home?.cartonCards ?? [] : [],
        products: lane === 'PRODUCT' ? home?.productCards ?? [] : [],
      }),
    [home, lane],
  );

  const identifierTypeFor = useCallback(
    (source: ScanSource, ocr: boolean): IdentifierType => {
      if (ocr) return 'OCR';
      if (source === 'CAMERA') return 'QR';
      if (source === 'EXTERNAL_SCANNER') return 'BARCODE';
      return 'MANUAL';
    },
    [],
  );

  /** Device-side match of a scanned value against the active lane's cards. */
  const handleScan = useCallback(
    (value: string, source: ScanSource, ocr = false) => {
      if (busy) return;
      const term = normalizeTerm(value);
      if (term.length < 2) {
        beepWarning();
        setFlash({ kind: 'MISMATCH', cardType: lane ?? 'PRODUCT', code: value, message: 'No code was read. Scan again.' });
        setStatus?.({ text: 'EMPTY SCAN', kind: 'warn' });
        return;
      }
      const startedAt = new Date().toISOString();
      if (lane === 'PRODUCT') {
        const card = matchProductCard(term, home?.productCards ?? []);
        if (card && card.remaining > 0) {
          beepInfo();
          setReview({ lane: 'PRODUCT', card, identifier: term, source, identifierType: identifierTypeFor(source, ocr), startedAt });
          setStatus?.({ text: 'MATCH FOUND', kind: 'info' });
        } else if (card) {
          beepWarning();
          setFlash({ kind: 'CARD_ALREADY_COMPLETE', cardType: 'PRODUCT', code: card.sku ?? term, message: 'This product card is already complete.' });
          setStatus?.({ text: 'CARD ALREADY COMPLETE', kind: 'warn' });
        } else {
          void logMismatch('PRODUCT', term, source, identifierTypeFor(source, ocr), startedAt);
        }
      } else if (lane === 'CARTON') {
        const verdict = matchCartonCard(term, home?.cartonCards ?? []);
        if (verdict.result === 'card') {
          beepInfo();
          setReview({ lane: 'CARTON', card: verdict.card, matchedOn: verdict.matchedOn, identifier: term, source, identifierType: identifierTypeFor(source, ocr), startedAt });
          setStatus?.({ text: 'MATCH FOUND', kind: 'info' });
        } else if (verdict.result === 'all-received') {
          beepWarning();
          setFlash({ kind: 'CARD_ALREADY_COMPLETE', cardType: 'CARTON', code: verdict.card.externalCartonId, message: 'This carton was already received.' });
          setStatus?.({ text: 'CARTON ALREADY RECEIVED', kind: 'warn' });
        } else if (verdict.result === 'ambiguous') {
          beepWarning();
          setFlash({ kind: 'TRACKING_AMBIGUOUS', cardType: 'CARTON', code: term, message: `The tracking matches ${verdict.cartons.length} cartons. Scan the specific carton.` });
          setStatus?.({ text: 'SCAN THE SPECIFIC CARTON', kind: 'warn' });
        } else {
          void logMismatch('CARTON', term, source, identifierTypeFor(source, ocr), startedAt);
        }
      }
    },
    [busy, lane, home, identifierTypeFor, setStatus],
  );

  const logMismatch = useCallback(
    async (cardType: Lane, term: string, source: ScanSource, identifierType: IdentifierType, startedAt: string) => {
      beepError();
      setFlash({ kind: 'MISMATCH', cardType, code: term, message: cardType === 'PRODUCT' ? 'No product card matches this code.' : 'No carton card matches this code.' });
      setStatus?.({ text: 'NOT MATCHED', kind: 'bad' });
      setLastAction?.(`MISMATCH ${term}`);
      try {
        const res = await receivingApi.homeMismatch({ cardType, identifier: term, identifierType, source, startedAt });
        setHome(res.home);
      } catch {
        // offline mismatch: counters stay as-is; nothing was confirmed.
      }
    },
    [setStatus, setLastAction],
  );

  /** CONFIRM — explicit operator action after a device MATCH. */
  const confirm = useCallback(async () => {
    if (!review || busy) return;
    setBusy(true);
    try {
      const op = freshOperationId();
      const res =
        review.lane === 'PRODUCT'
          ? await receivingApi.homeProduct({ identifier: review.identifier, identifierType: review.identifierType, quantity: 1, source: review.source, operationId: op, startedAt: review.startedAt })
          : await receivingApi.homeCarton({ identifier: review.identifier, identifierType: review.identifierType, source: review.source, operationId: op, startedAt: review.startedAt });
      setHome(res.home);
      setFlash(res.flash ?? null);
      const kind = res.flash?.kind ?? 'MISMATCH';
      if (kind === 'MATCH') { beepSuccess(); setStatus?.({ text: 'RECEIVED', kind: 'ok' }); setLastAction?.(`${review.lane} RECEIVED ${res.flash?.code ?? ''}`); }
      else if (kind === 'CARD_ALREADY_COMPLETE') { beepWarning(); setStatus?.({ text: 'ALREADY COMPLETE', kind: 'warn' }); }
      else if (kind === 'TRACKING_AMBIGUOUS') { beepWarning(); setStatus?.({ text: 'SCAN THE SPECIFIC CARTON', kind: 'warn' }); }
      else { beepError(); setStatus?.({ text: 'NOT MATCHED', kind: 'bad' }); }
      setReview(null);
      void reload();
    } catch (e) {
      beepError();
      setFlash({ kind: 'MISMATCH', code: review.identifier, message: e instanceof Error ? e.message : 'The backend could not validate this card.' });
      setStatus?.({ text: 'NOT ACCEPTED', kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }, [review, busy, reload, setStatus, setLastAction]);

  const openLane = (l: Lane) => {
    setLane(l);
    setFlash(null);
    setReview(null);
    setManual('');
    setScannerOpen(true);
  };

  const closeScanner = () => {
    setScannerOpen(false);
    setLane(null);
    setReview(null);
    setManual('');
  };

  if (loading) {
    return <div className="wt-center"><div className="wt-empty"><h1 className="os-muted">LOADING RECEIVING…</h1></div></div>;
  }

  const productCount = home?.productCardsPending ?? 0;
  const cartonCount = home?.cartonCardsPending ?? 0;

  return (
    <div className="rh">
      <header className="rh-head">
        <div>
          <h1 className="rh-title">RECEIVING</h1>
          <p className="os-muted">Cards arrive automatically. Scan a product or a carton — the matching card is found for you.</p>
        </div>
        <div className="os-row">
          <button type="button" className="os-btn os-btn--primary" onClick={() => navigate('/terminal/receiving/report')}>
            📋 RAPPORT DE CONFIRMÉ
          </button>
          <button type="button" className="os-btn" onClick={() => void load()}>REFRESH</button>
        </div>
      </header>

      {error && <div className="rt-error">{error}</div>}

      {/* ---------- the two receiving lanes ---------- */}
      <div className="rh-tiles">
        <section className="rh-tile" aria-label="PRODUIT">
          <div className="rh-tile-top">
            <span className="rh-tile-icon" aria-hidden="true">▦</span>
            <div>
              <h2 className="rh-tile-name">PRODUIT</h2>
              <p className="os-muted">Product cards waiting</p>
            </div>
          </div>
          <div className="rh-tile-count">
            <span className="rh-count-n">{productCount}</span>
            <span className="rh-count-l">CARDS</span>
          </div>
          <button type="button" className="os-btn os-btn--primary rh-scan-btn" onClick={() => openLane('PRODUCT')}>
            SCAN
          </button>
        </section>

        <section className="rh-tile" aria-label="CARTON">
          <div className="rh-tile-top">
            <span className="rh-tile-icon" aria-hidden="true">▣</span>
            <div>
              <h2 className="rh-tile-name">CARTON</h2>
              <p className="os-muted">Carton cards waiting</p>
            </div>
          </div>
          <div className="rh-tile-count">
            <span className="rh-count-n">{cartonCount}</span>
            <span className="rh-count-l">CARDS</span>
          </div>
          <button type="button" className="os-btn os-btn--primary rh-scan-btn" onClick={() => openLane('CARTON')}>
            SCAN
          </button>
        </section>
      </div>

      {/* ---------- card lists (information only — never a card picker) ---------- */}
      <div className="rh-lists">
        <section className="rh-list">
          <h3 className="rh-list-title">PRODUIT — {productCount} CARDS</h3>
          {productCount === 0 ? (
            <p className="os-muted rh-empty">No product cards waiting.</p>
          ) : (
            <ol className="rh-rows">
              {(home?.productList ?? []).slice(0, 50).map((p, i) => (
                <li key={`${p.arrivalCode}-${p.reference}-${i}`} className="rh-row">
                  <span className="rh-row-n">#{i + 1}</span>
                  <span className="mono">{p.reference ?? '—'}</span>
                  <span className="os-muted rh-row-meta">{p.label ? `${p.label} · ` : ''}{p.arrivalCode}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="rh-list">
          <h3 className="rh-list-title">CARTON — {cartonCount} CARDS</h3>
          {cartonCount === 0 ? (
            <p className="os-muted rh-empty">No carton cards waiting.</p>
          ) : (
            <ol className="rh-rows">
              {(home?.cartonList ?? []).slice(0, 50).map((c, i) => (
                <li key={`${c.arrivalCode}-${c.reference}-${i}`} className="rh-row">
                  <span className="rh-row-n">#{i + 1}</span>
                  <span className="mono">{c.reference}</span>
                  <span className="os-muted rh-row-meta">{c.tracking ? `TRK ${c.tracking} · ` : ''}{c.arrivalCode}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* ---------- lane-specific scanner overlay ---------- */}
      {scannerOpen && lane && (
        <div className="rh-scanner" role="dialog" aria-modal="true">
          <div className="rh-scanner-inner">
            <header className="rh-scanner-head os-spread">
              <h2 className="rh-scanner-title">{lane === 'PRODUCT' ? 'PRODUCT SCANNER' : 'CARTON SCANNER'}</h2>
              <button type="button" className="os-btn" onClick={closeScanner}>✕ CLOSE</button>
            </header>

            {!review ? (
              <>
                <Suspense fallback={<div className="os-muted">STARTING SCANNER…</div>}>
                  <ReceivingScanner
                    title={`RECEIVING · ${lane === 'PRODUCT' ? 'PRODUIT' : 'CARTON'}`}
                    mode={lane === 'PRODUCT' ? 'PRODUCT' : 'CARTON'}
                    onModeChange={() => { /* lanes are fixed inside each scanner */ }}
                    enableOcr
                    corpus={corpus}
                    scanContext={scanContext}
                    onDetected={(value: string, source: ScanSource) => handleScan(value, source, false)}
                    onClose={closeScanner}
                  />
                </Suspense>

                {/* Manual fallback — same pipeline, same lane. */}
                <form
                  className="rt-manual"
                  onSubmit={(e) => { e.preventDefault(); if (manual.trim()) { handleScan(manual, 'MANUAL', false); setManual(''); } }}
                >
                  <div className="os-row">
                    <input
                      className="os-input"
                      style={{ flex: 1 }}
                      placeholder={lane === 'PRODUCT' ? 'Type / scan product SKU or reference' : 'Type / scan carton ref, QR, barcode or tracking'}
                      value={manual}
                      onChange={(e) => setManual(e.target.value)}
                    />
                    <button type="submit" className="os-btn os-btn--primary" disabled={!manual.trim()}>MATCH</button>
                  </div>
                </form>
              </>
            ) : (
              <div className="rh-review">
                <div className="rt-outcome rt-outcome--ok">MATCH FOUND — {review.lane === 'PRODUCT' ? 'PRODUIT' : 'CARTON'}</div>
                <div className="rh-review-card os-card">
                  {review.lane === 'PRODUCT' ? (
                    <>
                      <p className="mono rh-review-ref">{review.card.sku ?? review.card.reference}</p>
                      <p>{review.card.productName ?? 'Product card'}</p>
                      <p className="os-muted">Scanned: <span className="mono">{review.identifier}</span> · {review.identifierType}</p>
                    </>
                  ) : (
                    <>
                      <p className="mono rh-review-ref">{review.card.externalCartonId}</p>
                      <p>{review.card.reference ?? 'Carton card'}{review.card.trackingNumber ? ` · TRK ${review.card.trackingNumber}` : ''}</p>
                      <p className="os-muted">Matched on {review.matchedOn} · Scanned: <span className="mono">{review.identifier}</span> · {review.identifierType}</p>
                    </>
                  )}
                </div>
                <div className="os-row rh-review-actions">
                  <button type="button" className="os-btn" onClick={() => setReview(null)} disabled={busy}>SCAN NEXT</button>
                  <button type="button" className="os-btn os-btn--primary" onClick={() => void confirm()} disabled={busy}>
                    {busy ? 'CONFIRMING…' : 'CONFIRM'}
                  </button>
                </div>
              </div>
            )}

            {flash && !review && (
              <div className={`rt-outcome ${flash.kind === 'MATCH' ? 'rt-outcome--ok' : flash.kind === 'CARD_ALREADY_COMPLETE' || flash.kind === 'TRACKING_AMBIGUOUS' ? 'rt-outcome--info' : 'rt-outcome--bad'}`}>
                {flash.message ?? flash.kind}{flash.code ? ` (${flash.code})` : ''}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
