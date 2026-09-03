import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { fulfillmentApi, type PackingView } from './fulfillment-api';
import { beepSuccess, beepError, beepInfo, beepDone } from '../modules/receiving-terminal/feedback';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import { printLabel } from './print-label';
import './flow-task.css';

const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

/**
 * PACKING terminal.
 *
 * Scan the customer bin QR -> the system shows CUSTOMER + ORDER + REQUIRED
 * ITEMS vs what is physically in the bin. Only a complete bin can be packed;
 * PACK creates the outbound shipment with an internal label code (tracking
 * stays empty until a real carrier adapter exists — nothing is invented).
 */

export default function PackingTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const [scannerOpen, setScannerOpen] = useState(false);
  const [view, setView] = useState<PackingView | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string; token: number } | null>(null);
  const [packedShipment, setPackedShipment] = useState<{ code: string; carrier: string | null; trackingNumber: string | null } | null>(null);
  const [packedOrder, setPackedOrder] = useState<{ reference: string; customer: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const report = useCallback((kind: 'ok' | 'bad' | 'info', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    setLastAction(text);
    if (kind === 'ok') beepSuccess(); else if (kind === 'bad') beepError(); else beepInfo();
  }, [setLastAction]);

  const scanBin = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setPackedShipment(null);
    try {
      const v = await fulfillmentApi.packingScan(value);
      setView(v);
      setStatus({ text: v.complete ? 'VERIFY & PACK' : 'BIN INCOMPLETE', kind: v.complete ? 'ok' : 'bad' });
      report(v.complete ? 'info' : 'bad',
        v.complete
          ? `${v.bin.code} — ${v.order.customer} — COMPLETE, VERIFY & PACK`
          : `${v.bin.code} — ORDER INCOMPLETE`);
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      setView(null);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, report, setStatus]);

  async function doPack() {
    if (!view || busy) return;
    setBusy(true);
    try {
      const res = await fulfillmentApi.pack(view.bin.code);
      beepDone();
      setPackedShipment(res.shipment);
      setPackedOrder(view.order);
      report('ok', `PACKED → SHIPMENT ${res.shipment.code}`);
      setView(null);
      setStatus({ text: 'SCAN NEXT BIN', kind: 'info' });
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Could not pack';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
    } finally { setBusy(false); }
  }

  return (
    <div className="fl">
      <div className="fl-bar">
        <div>
          <h1 className="fl-h1">PACKING</h1>
          <p className="fl-sub">Scan a customer bin → verify contents → pack into a shipping carton.</p>
        </div>
        <button className="os-btn os-btn--primary" onClick={() => setScannerOpen(true)}>
          OPEN SCANNER
        </button>
      </div>

      <div className="fl-input">
        <label className="os-label" htmlFor="fl-pack-field">SCAN OR TYPE BIN QR</label>
        <div className="os-row">
          <input
            id="fl-pack-field"
            ref={inputRef}
            className="os-input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const v = manual; setManual(''); void scanBin(v); }
            }}
            placeholder="BIN-…"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          <button
            className="os-btn"
            disabled={busy || !manual.trim()}
            onClick={() => { const v = manual; setManual(''); void scanBin(v); }}
          >
            ENTER
          </button>
        </div>
      </div>

      {outcome && !scannerOpen && (
        <div key={outcome.token} className={`fl-outcome fl-outcome--${outcome.kind}`}>
          {outcome.kind === 'ok' ? '✓ ' : outcome.kind === 'bad' ? '✕ ' : ''}{outcome.text}
        </div>
      )}

      {scannerOpen && (
        <Suspense fallback={<div className="os-empty">STARTING SCANNER…</div>}>
          <ContinuousScanner
            title="SCAN CUSTOMER BIN"
            enableOcr={ocrAllowed}
            outcome={outcome}
            onDetected={(value) => { void scanBin(value); }}
            onClose={() => { setScannerOpen(false); setOutcome(null); }}
          />
        </Suspense>
      )}

      {view && (
        <>
          <div className={`fl-decision${view.complete ? '' : ' is-warn'}`}>
            <div className="fl-decision-row">
              <div>
                <div className="fl-decision-k">BIN</div>
                <div className="fl-decision-v">{view.bin.code}</div>
              </div>
              <div>
                <div className="fl-decision-k">CUSTOMER</div>
                <div className="fl-decision-v ok">{view.order.customer}</div>
              </div>
              <div>
                <div className="fl-decision-k">ORDER</div>
                <div className="fl-decision-v">{view.order.reference}</div>
              </div>
              <div>
                <div className="fl-decision-k">STATUS</div>
                <div className={`fl-decision-v ${view.complete ? 'ok' : 'warn'}`}>
                  {view.complete ? 'COMPLETE' : 'INCOMPLETE'}
                </div>
              </div>
            </div>
          </div>

          <section className="os-card">
            <h2 className="os-card-title">Required items — verify each one physically</h2>
            <div className="fl-list">
              {view.required.map((r) => (
                <div key={r.sku} className={`fl-row${r.inBin >= r.requested ? ' is-ok' : ' is-short'}`}>
                  <span className="os-mono">{r.sku}</span>
                  <span>{r.productName}</span>
                  <span className={`os-tag ${r.inBin >= r.requested ? 'os-tag--ok' : 'os-tag--warn'}`}>
                    {r.inBin}/{r.requested}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <button
            className="os-btn os-btn--primary"
            style={{ fontSize: '1.05rem', padding: '18px 24px', letterSpacing: '0.14em' }}
            disabled={busy || !view.complete}
            onClick={() => void doPack()}
          >
            {view.complete ? 'CONFIRM PACKED — CREATE SHIPMENT' : 'BIN INCOMPLETE — CANNOT PACK'}
          </button>
        </>
      )}

      {packedShipment && (
        <div className="fl-decision">
          <div className="fl-decision-k">SHIPPING LABEL — attach to the carton</div>
          <div className="fl-biglabel">{packedShipment.code}</div>
          <div className="fl-decision-row">
            <div>
              <div className="fl-decision-k">CARRIER</div>
              <div className="fl-decision-v">{packedShipment.carrier ?? 'INTERNAL (no carrier connected)'}</div>
            </div>
            <div>
              <div className="fl-decision-k">TRACKING</div>
              <div className="fl-decision-v">{packedShipment.trackingNumber ?? '—'}</div>
            </div>
          </div>
          <div className="os-muted">Status: READY_TO_SHIP — move the carton to the shipping area.</div>
          <button
            className="os-btn os-btn--primary"
            onClick={() =>
              printLabel({
                kind: 'SHIPPING LABEL',
                code: packedShipment.code,
                bigLabel: packedOrder?.customer ?? null,
                lines: [
                  ...(packedOrder ? [{ k: 'ORDER', v: packedOrder.reference }] : []),
                  { k: 'CARRIER', v: packedShipment.carrier ?? 'INTERNAL' },
                  { k: 'TRACKING', v: packedShipment.trackingNumber ?? '—' },
                ],
              })
            }
          >
            🖨 PRINT LABEL
          </button>
        </div>
      )}
    </div>
  );
}
