import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { fulfillmentApi, type OutboundShipmentView } from './fulfillment-api';
import { beepSuccess, beepError, beepInfo, beepDone } from '../modules/receiving-terminal/feedback';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import './flow-task.css';

const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

/**
 * SHIPPING terminal.
 *
 * Scan the shipment label (OUT-…) at the shipping area -> the system shows
 * order, customer and contents -> CONFIRM DISPATCH records the shipping
 * event, marks every article SHIPPED and closes the customer bin (audited;
 * history is never deleted).
 */

export default function ShippingTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const [scannerOpen, setScannerOpen] = useState(false);
  const [shipment, setShipment] = useState<OutboundShipmentView | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string; token: number } | null>(null);
  const [shippedCount, setShippedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const report = useCallback((kind: 'ok' | 'bad' | 'info', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    setLastAction(text);
    if (kind === 'ok') beepSuccess(); else if (kind === 'bad') beepError(); else beepInfo();
  }, [setLastAction]);

  const scan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const s = await fulfillmentApi.shippingScan(value);
      setShipment(s);
      if (s.status === 'SHIPPED') {
        setStatus({ text: 'ALREADY SHIPPED', kind: 'bad' });
        report('bad', `${s.code} — ALREADY SHIPPED`);
      } else {
        setStatus({ text: 'CONFIRM DISPATCH', kind: 'ok' });
        report('info', `${s.code} — ${s.order?.externalCustomerReference ?? ''} — CONFIRM DISPATCH`);
      }
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      setShipment(null);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, report, setStatus]);

  async function dispatch() {
    if (!shipment || busy) return;
    setBusy(true);
    try {
      await fulfillmentApi.ship(shipment.code);
      beepDone();
      report('ok', `${shipment.code} SHIPPED`);
      setShippedCount((n) => n + 1);
      setShipment(null);
      setStatus({ text: 'SCAN NEXT SHIPMENT', kind: 'info' });
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Could not dispatch';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
    } finally { setBusy(false); }
  }

  return (
    <div className="fl">
      <div className="fl-bar">
        <div>
          <h1 className="fl-h1">SHIPPING</h1>
          <p className="fl-sub">Scan the shipment label → confirm dispatch.</p>
        </div>
        <div className="os-row" style={{ gap: 10, alignItems: 'center' }}>
          <button className="os-btn os-btn--primary" onClick={() => setScannerOpen(true)}>
            OPEN SCANNER
          </button>
          <div className="fl-metric is-ok" style={{ padding: '8px 16px' }}>
            <div className="fl-metric-v">{shippedCount}</div>
            <div className="fl-metric-l">SHIPPED NOW</div>
          </div>
        </div>
      </div>

      <div className="fl-input">
        <label className="os-label" htmlFor="fl-ship-field">SCAN OR TYPE SHIPMENT LABEL</label>
        <div className="os-row">
          <input
            id="fl-ship-field"
            ref={inputRef}
            className="os-input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const v = manual; setManual(''); void scan(v); }
            }}
            placeholder="OUT-…"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          <button
            className="os-btn"
            disabled={busy || !manual.trim()}
            onClick={() => { const v = manual; setManual(''); void scan(v); }}
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
            title="SCAN SHIPMENT LABEL"
            enableOcr={ocrAllowed}
            outcome={outcome}
            onDetected={(value) => { void scan(value); }}
            onClose={() => { setScannerOpen(false); setOutcome(null); }}
          />
        </Suspense>
      )}

      {shipment && (
        <>
          <div className={`fl-decision${shipment.status === 'SHIPPED' ? ' is-warn' : ''}`}>
            <div className="fl-decision-row">
              <div>
                <div className="fl-decision-k">SHIPMENT</div>
                <div className="fl-decision-v">{shipment.code}</div>
              </div>
              <div>
                <div className="fl-decision-k">CUSTOMER</div>
                <div className="fl-decision-v ok">{shipment.order?.externalCustomerReference ?? '—'}</div>
              </div>
              <div>
                <div className="fl-decision-k">ORDER</div>
                <div className="fl-decision-v">{shipment.order?.externalOrderReference ?? '—'}</div>
              </div>
              <div>
                <div className="fl-decision-k">STATUS</div>
                <div className={`fl-decision-v ${shipment.status === 'SHIPPED' ? 'warn' : 'ok'}`}>{shipment.status}</div>
              </div>
            </div>
            <div className="fl-decision-row">
              <div>
                <div className="fl-decision-k">CARRIER</div>
                <div className="fl-decision-v">{shipment.carrier ?? 'INTERNAL'}</div>
              </div>
              <div>
                <div className="fl-decision-k">TRACKING</div>
                <div className="fl-decision-v">{shipment.trackingNumber ?? '—'}</div>
              </div>
            </div>
          </div>

          <section className="os-card">
            <h2 className="os-card-title">Contents</h2>
            <div className="fl-list">
              {(shipment.articles ?? []).map((a) => (
                <div key={a.code} className="fl-row">
                  <span className="os-mono">{a.code}</span>
                  <span className="os-mono">{a.sku}</span>
                  <span>{a.productName ?? ''}</span>
                  <span className="os-tag os-tag--muted">{a.status}</span>
                </div>
              ))}
            </div>
          </section>

          {shipment.status !== 'SHIPPED' && (
            <button
              className="os-btn os-btn--primary"
              style={{ fontSize: '1.05rem', padding: '18px 24px', letterSpacing: '0.14em' }}
              disabled={busy}
              onClick={() => void dispatch()}
            >
              CONFIRM DISPATCH — MARK SHIPPED
            </button>
          )}
        </>
      )}
    </div>
  );
}
