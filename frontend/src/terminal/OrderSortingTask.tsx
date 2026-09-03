import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { fulfillmentApi, type OrderSortingScanResult, type OpContainer } from './fulfillment-api';
import { beepSuccess, beepError, beepInfo, beepDone } from '../modules/receiving-terminal/feedback';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import { printLabel } from './print-label';
import './flow-task.css';

const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

/**
 * CUSTOMER ORDER SORTING terminal.
 *
 * Step 1: scan an ARTICLE -> the system finds the matching open order and
 *         shows PRODUCT → CUSTOMER → CONTAINER (SKU: SH-001 / CUSTOMER:
 *         AHMED / BIN: BIN-000001).
 * Step 2: scan the BIN    -> backend validates it is THE bin of that order;
 *         wrong bin / wrong customer / unneeded article are rejected with a
 *         clear red warning. When the order is complete the bin flips to
 *         READY_FOR_PACKING.
 *
 * Bins are created here too (scan-free flow for the supervisor): pick an
 * order reference, get a QR-coded bin with the big customer label.
 */

type Step = 'ARTICLE' | 'BIN';

export default function OrderSortingTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const [step, setStep] = useState<Step>('ARTICLE');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [decision, setDecision] = useState<OrderSortingScanResult | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string; token: number } | null>(null);
  const [assigned, setAssigned] = useState(0);
  const [bins, setBins] = useState<OpContainer[]>([]);
  const [newBinRef, setNewBinRef] = useState('');
  const [log, setLog] = useState<Array<{ t: string; text: string; kind: 'ok' | 'bad' | 'info' }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const push = useCallback((text: string, kind: 'ok' | 'bad' | 'info') => {
    setLog((l) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 40));
    setLastAction(text);
  }, [setLastAction]);

  const report = useCallback((kind: 'ok' | 'bad' | 'info', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    if (kind === 'ok') beepSuccess(); else if (kind === 'bad') beepError(); else beepInfo();
  }, []);

  const refreshBins = useCallback(async () => {
    try { setBins(await fulfillmentApi.containers({ type: 'CUSTOMER' })); } catch { /* advisory */ }
  }, []);

  useEffect(() => { void refreshBins(); }, [refreshBins]);

  useEffect(() => {
    setStatus(step === 'ARTICLE'
      ? { text: 'SCAN ARTICLE', kind: 'info' }
      : { text: 'SCAN CUSTOMER BIN', kind: 'ok' });
  }, [step, setStatus]);

  const assignment = decision?.kind === 'ASSIGNMENT' ? decision : null;

  const submit = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (step === 'ARTICLE') {
        const res = await fulfillmentApi.orderSortingScan(value);
        setDecision(res);
        if (res.kind === 'ASSIGNMENT') {
          setStep('BIN');
          report('info', `${res.article.sku} → ${res.order.customer} → ${res.bin?.code ?? 'NO BIN YET'}`);
          push(`${res.article.code} → ${res.order.reference}`, 'info');
        } else if (res.kind === 'NO_ORDER') {
          report('bad', res.reason);
          push(res.reason, 'bad');
        } else {
          report('bad', res.reason);
          push(res.reason, 'bad');
        }
        return;
      }
      // BIN step -> commit assignment (server re-validates everything).
      if (!assignment) { setStep('ARTICLE'); return; }
      const res = await fulfillmentApi.orderSortingAssign({
        articleCode: assignment.article.code,
        containerCode: value,
      });
      if (res.flash.kind === 'BIN_READY_FOR_PACKING') {
        beepDone();
        report('ok', `${res.flash.bin} COMPLETE → READY FOR PACKING`);
        push(`${res.flash.bin} READY_FOR_PACKING (${res.flash.customer})`, 'ok');
      } else {
        report('ok', `${res.flash.article} → ${res.flash.bin} (${res.flash.customer})`);
        push(`${res.flash.article} → ${res.flash.bin}`, 'ok');
      }
      setAssigned((n) => n + 1);
      setDecision(null);
      setStep('ARTICLE');
      await refreshBins();
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      push(String(Array.isArray(m) ? m.join(', ') : m), 'bad');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, step, assignment, report, push, refreshBins]);

  async function createBin() {
    const ref = newBinRef.trim();
    if (!ref || busy) return;
    setBusy(true);
    try {
      const bin = await fulfillmentApi.createContainer({ type: 'CUSTOMER', orderReference: ref });
      report('ok', `BIN ${bin.code} → ${bin.label ?? ref}`);
      push(`bin ${bin.code} created for ${ref}`, 'ok');
      setNewBinRef('');
      await refreshBins();
      // Print the big customer label right away — the bin is useless unlabelled.
      printLabel({
        kind: 'CUSTOMER BIN',
        code: bin.code,
        bigLabel: bin.label ?? ref,
        lines: [{ k: 'ORDER', v: bin.order?.externalOrderReference ?? ref.toUpperCase() }],
      });
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Could not create bin';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
    } finally { setBusy(false); }
  }

  return (
    <div className="fl">
      <div className="fl-bar">
        <div>
          <h1 className="fl-h1">ORDER SORTING</h1>
          <p className="fl-sub">Article → customer order → customer bin.</p>
        </div>
        <div className="os-row" style={{ gap: 10, alignItems: 'center' }}>
          <button className="os-btn os-btn--primary" onClick={() => setScannerOpen(true)}>
            OPEN SCANNER
          </button>
          <div className="fl-metric is-ok" style={{ padding: '8px 16px' }}>
            <div className="fl-metric-v">{assigned}</div>
            <div className="fl-metric-l">ASSIGNED</div>
          </div>
        </div>
      </div>

      <div className="fl-steps">
        <div className={`fl-step${step === 'ARTICLE' ? ' is-active' : ''}${assignment ? ' is-done' : ''}`}>
          <div className="fl-step-n">1</div>
          <div>
            <div className="fl-step-t">ARTICLE</div>
            <div className="fl-step-v">
              {assignment ? `${assignment.article.code} · ${assignment.article.sku}` : '— scan an article —'}
            </div>
          </div>
        </div>
        <div className={`fl-step${step === 'BIN' ? ' is-active' : ''}`}>
          <div className="fl-step-n">2</div>
          <div>
            <div className="fl-step-t">CUSTOMER BIN</div>
            <div className="fl-step-v">{step === 'BIN' ? '— scan the bin QR —' : 'waiting for article'}</div>
          </div>
        </div>
      </div>

      {/* SYSTEM DECISION — PRODUCT → CUSTOMER → CONTAINER. */}
      {assignment && (
        <div className={`fl-decision${assignment.binMissing ? ' is-warn' : ''}`}>
          <div className="fl-decision-row">
            <div>
              <div className="fl-decision-k">SKU</div>
              <div className="fl-decision-v">{assignment.article.sku}</div>
            </div>
            <div>
              <div className="fl-decision-k">CUSTOMER</div>
              <div className="fl-decision-v ok">{assignment.order.customer}</div>
            </div>
            <div>
              <div className="fl-decision-k">BIN</div>
              <div className={`fl-decision-v ${assignment.bin ? 'ok' : 'warn'}`}>
                {assignment.bin?.code ?? 'NO BIN — CREATE ONE BELOW'}
              </div>
            </div>
          </div>
          <div className="os-muted">Order {assignment.order.reference} — put the article in the bin, then scan the bin QR to confirm.</div>
        </div>
      )}
      {decision?.kind === 'NO_ORDER' && (
        <div className="fl-decision is-warn">
          <div className="fl-decision-k">NO MATCHING ORDER</div>
          <div className="fl-decision-v warn">{decision.reason}</div>
          <div className="os-muted">Set the article aside — a supervisor decides. Nothing was changed.</div>
        </div>
      )}

      <div className="fl-input">
        <label className="os-label" htmlFor="fl-os-field">
          {step === 'ARTICLE' ? 'SCAN OR TYPE ARTICLE CODE' : 'SCAN OR TYPE BIN QR'}
        </label>
        <div className="os-row">
          <input
            id="fl-os-field"
            ref={inputRef}
            className="os-input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const v = manual; setManual(''); void submit(v); }
            }}
            placeholder={step === 'ARTICLE' ? 'ART-…' : 'BIN-…'}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          <button
            className="os-btn"
            disabled={busy || !manual.trim()}
            onClick={() => { const v = manual; setManual(''); void submit(v); }}
          >
            ENTER
          </button>
          {assignment && (
            <button
              className="os-btn"
              disabled={busy}
              onClick={() => { setDecision(null); setStep('ARTICLE'); push('article cleared', 'info'); }}
            >
              CANCEL
            </button>
          )}
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
            title={step === 'ARTICLE' ? 'SCAN ARTICLE' : `SCAN BIN ${assignment?.bin?.code ?? ''}`}
            enableOcr={ocrAllowed}
            outcome={outcome}
            onDetected={(value) => { void submit(value); }}
            onClose={() => { setScannerOpen(false); setOutcome(null); }}
          />
        </Suspense>
      )}

      <div className="pt-cols" style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
        <section className="os-card">
          <h2 className="os-card-title">Customer bins</h2>
          <div className="fl-list">
            {bins.length === 0 && <div className="os-muted">No customer bins yet.</div>}
            {bins.map((b) => (
              <div key={b.id} className={`fl-row${b.status === 'READY_FOR_PACKING' ? ' is-ok' : ''}`}>
                <span className="os-mono">{b.code}</span>
                <span className="fl-biglabel" style={{ fontSize: '1rem' }}>{b.label ?? ''}</span>
                <span className="os-muted">{b.order?.externalOrderReference ?? ''}</span>
                <span className={`os-tag ${b.status === 'READY_FOR_PACKING' ? 'os-tag--ok' : b.status === 'ACTIVE' ? 'os-tag--muted' : 'os-tag--warn'}`}>
                  {b.status}
                </span>
                <span className="os-muted">{b._count?.articles ?? 0} items</span>
                <button
                  className="os-btn"
                  style={{ padding: '2px 10px' }}
                  title="Print the bin QR label"
                  onClick={() =>
                    printLabel({
                      kind: 'CUSTOMER BIN',
                      code: b.code,
                      bigLabel: b.label,
                      lines: b.order ? [{ k: 'ORDER', v: b.order.externalOrderReference }] : [],
                    })
                  }
                >
                  🖨
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="os-card">
          <h2 className="os-card-title">New customer bin</h2>
          <p className="os-muted">Creates a QR-coded bin labelled with the customer for one open order.</p>
          <div className="os-row" style={{ gap: 10 }}>
            <input
              className="os-input"
              value={newBinRef}
              onChange={(e) => setNewBinRef(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void createBin(); } }}
              placeholder="ORDER REFERENCE (ORD-…)"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={busy}
            />
            <button className="os-btn os-btn--primary" disabled={busy || !newBinRef.trim()} onClick={() => void createBin()}>
              CREATE BIN
            </button>
          </div>
        </section>
      </div>

      {log.length > 0 && (
        <section className="os-card">
          <h2 className="os-card-title">Activity</h2>
          <div className="fl-log">
            {log.map((l, i) => (
              <div key={i} className={`fl-log-item ${l.kind}`}>
                <span className="os-muted">{l.t}</span> {l.text}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
