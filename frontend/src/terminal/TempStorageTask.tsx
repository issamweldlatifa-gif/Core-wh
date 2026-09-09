import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../api/client';
import { beepSuccess, beepError, beepInfo, beepWarning, beepDone } from '../modules/receiving-terminal/feedback';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import { tsApi, newOperationId, type TsHome, type TsSectionBoard } from './temp-storage-api';
import './flow-task.css';
import './temp-storage-task.css';

const ContinuousScanner = lazy(() => import('../modules/receiving-terminal/ContinuousScanner'));

/**
 * TEMPORARY STORAGE station — Web Terminal / CT40 (MASTER ORDER §14-§22).
 *
 * Scan-first loop, exactly like Sorting:
 *   1. SCAN PRODUCT  -> the SYSTEM resolves customer -> section -> target
 *                       container (server-authoritative). The target container
 *                       GLOWS in amber on the board so the worker instantly
 *                       knows which container to use (no typing, no guessing).
 *   2. SCAN CONTAINER -> server validates: VALID / WRONG_CONTAINER /
 *                        CONTAINER_FULL / REVIEW / CARTON_NOT_ALLOWED.
 *
 * All data shown comes from the real workflow endpoints (never static mocks).
 */
interface PendingUnit {
  operationId: string;
  code: string;
  customer: string;
  surname: string | null;
  productLabel: string;
  section: string;
  target: { code: string; current: number; capacity: number; status: string; mustCreate: boolean };
  remaining: number;
}

interface Outcome { kind: 'ok' | 'bad' | 'info'; text: string; token: number }
interface Flash { code: string; kind: 'ok' | 'bad'; token: number }

export default function TempStorageTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const [letter, setLetter] = useState<string | null>(null);
  const [home, setHome] = useState<TsHome | null>(null);
  const [board, setBoard] = useState<TsSectionBoard | null>(null);
  const [pending, setPending] = useState<PendingUnit | null>(null);
  const [notFound, setNotFound] = useState<{ code: string } | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [log, setLog] = useState<Array<{ t: string; text: string; kind: 'ok' | 'bad' | 'info' }>>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [repOpen, setRepOpen] = useState(false);
  const [repObs, setRepObs] = useState('');
  const [reportedAt, setReportedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const push = useCallback((text: string, kind: 'ok' | 'bad' | 'info') => {
    setLog((l) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...l].slice(0, 40));
    setLastAction(text);
  }, [setLastAction]);

  const report = useCallback((kind: 'ok' | 'bad' | 'info', text: string) => {
    setOutcome({ kind, text, token: Date.now() });
    if (kind === 'ok') beepSuccess(); else if (kind === 'bad') beepError(); else beepInfo();
  }, []);

  /** Refetch the live boards from the real endpoints after every mutation. */
  const reload = useCallback(async () => {
    try { const h = await tsApi.home(); setHome(h); } catch { /* keep last known */ }
    if (letter) {
      try { const b = await tsApi.section(letter); setBoard(b); } catch { /* keep last known */ }
    }
  }, [letter]);

  // Initial + letter-change load.
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setStatus(pending
      ? { text: `SCAN CONTAINER ${pending.target.code}`, kind: 'ok' }
      : { text: letter ? `SECTION ${letter} — SCAN PRODUCT` : 'SCAN PRODUCT', kind: 'info' });
  }, [pending, letter, setStatus]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1000);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!scannerOpen && !busy) inputRef.current?.focus();
  }, [scannerOpen, busy, pending, notFound, letter]);

  /** STEP 1 — a product scan: the server decides the target container. */
  const productScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const operationId = newOperationId();
      const res = await tsApi.scan(value, operationId);
      if (res.status === 'VALID' && res.product && res.targetContainer) {
        setNotFound(null);
        setPending({
          operationId,
          code: value,
          customer: res.product.customer,
          surname: res.product.surname ?? null,
          productLabel: res.product.productName ?? res.product.reference ?? res.product.sku ?? value,
          section: res.product.section,
          target: res.targetContainer,
          remaining: res.remaining ?? 0,
        });
        report('info', `SCAN CONTAINER ${res.targetContainer.code}${res.targetContainer.mustCreate ? ' (NEW)' : ''}`);
        push(`${value} → ${res.product.customer} · ${res.product.section} → ${res.targetContainer.code}`, 'info');
      } else if (res.status === 'PRODUCT_NOT_FOUND') {
        setNotFound({ code: value });
        report('bad', 'NO CONFIRMED PRODUCT — SEND TO REVIEW?');
        push(`${value}: no confirmed unit — review lane`, 'bad');
      } else {
        report('bad', res.message ?? res.status);
        push(`${value}: ${res.status}`, 'bad');
      }
    } catch (e: any) {
      report('bad', apiErrorMessage(e));
      push(`scan failed: ${apiErrorMessage(e)}`, 'bad');
    } finally {
      setBusy(false);
    }
  }, [busy, report, push]);

  /** STEP 2 — a container scan: the server validates and stores (or rejects). */
  const containerScan = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy || !pending) return;
    setBusy(true);
    try {
      const res = await tsApi.place(pending.code, value, pending.operationId);
      if (res.status === 'VALID') {
        setFlash({ code: pending.target.code, kind: 'ok', token: Date.now() });
        const c = res.container;
        report('ok', `STORED → ${c?.code ?? pending.target.code}${c ? ` ${c.current}/${c.capacity}` : ''} · ${res.remaining ?? 0} LEFT`);
        push(`${pending.code} → ${c?.code ?? pending.target.code}`, 'ok');
        setPending(null);
        if (res.nextTarget) {
          report('info', `CONTAINER FULL — NEXT ${res.nextTarget.code} READY · scan the product again`);
        } else if ((res.remaining ?? 0) <= 0) {
          beepDone();
          report('ok', 'ALL UNITS OF THIS PRODUCT STORED');
        }
      } else if (res.status === 'WRONG_CONTAINER') {
        setFlash({ code: value, kind: 'bad', token: Date.now() });
        report('bad', res.message ?? 'WRONG CONTAINER — nothing stored');
        if (res.expected) {
          push(`expected ${res.expected.containerCode} (section ${res.expected.section})`, 'bad');
          // Re-point the amber target at the server-designated container.
          setPending((p) => (p ? { ...p, target: { code: res.expected!.containerCode, current: 0, capacity: 0, status: 'EMPTY', mustCreate: true } } : p));
        }
      } else if (res.status === 'REVIEW' || res.status === 'ALREADY_IN_REVIEW') {
        report('bad', res.status === 'REVIEW' ? 'PRODUCT SENT TO REVIEW (admin alerted)' : 'ALREADY IN REVIEW');
        setPending(null);
        push(`${pending.code}: review lane`, 'bad');
      } else {
        report('bad', res.message ?? res.status);
        push(`${pending.code} → ${value}: ${res.status}`, 'bad');
      }
      await reload();
    } catch (e: any) {
      report('bad', apiErrorMessage(e));
      push(`placement failed: ${apiErrorMessage(e)}`, 'bad');
      await reload();
    } finally {
      setBusy(false);
    }
  }, [busy, pending, report, push, reload]);

  const sendToReview = useCallback(async () => {
    if (!notFound || busy) return;
    setBusy(true);
    try {
      const res = await tsApi.review(notFound.code, 'Product not recognised as a confirmed unit at Temporary Storage scan.', newOperationId());
      beepWarning();
      report('info', res.status === 'REVIEW' ? '→ REVIEW LANE · ADMIN ALERTED' : 'ALREADY IN REVIEW');
      push(`${notFound.code} → review + exception`, 'info');
      setNotFound(null);
      await reload();
    } catch (e: any) {
      report('bad', apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [notFound, busy, report, push, reload]);

  const submitRapport = useCallback(async () => {
    if (busy || reportedAt) return;
    setBusy(true);
    try {
      const res = await tsApi.reportFin(repObs.trim() || undefined);
      beepDone();
      setReportedAt(new Date().toLocaleTimeString());
      report('ok', 'RAPPORT DE FIN SUBMITTED → ADMIN REPORTS');
      push(`rapport de fin ${res.id ? `#${res.id.slice(0, 8)} ` : ''}submitted`, 'ok');
      setRepOpen(false);
    } catch (e: any) {
      report('bad', apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, reportedAt, repObs, report, push]);

  /** One scan field: product first, then the amber container. */
  const submit = useCallback(async (raw: string) => {
    if (pending) await containerScan(raw); else await productScan(raw);
  }, [pending, containerScan, productScan]);

  const openSection = (l: string) => {
    setLetter(l);
    setPending(null);
    setNotFound(null);
    setOutcome(null);
  };

  const highlight = pending?.target.code ?? null;

  const flashCls = (code: string) => {
    if (flash && flash.code === code && flash.kind === 'ok') return ' ts-ctr is-just-stored';
    if (flash && flash.code === code && flash.kind === 'bad') return ' ts-ctr is-wrong-scan';
    return '';
  };

  const targetCls = (code: string) => (highlight && highlight === code && pending ? ' is-target' : '');

  return (
    <div className="fl">
      <div className="fl-bar">
        <div>
          <h1 className="fl-h1">TEMPORARY STORAGE</h1>
          <p className="fl-sub">
            {ctx?.station ? `Station ${ctx.station.code} · ${ctx.station.name} — scan product → place in the GLOWING container.` : 'Waiting for a station…'}
          </p>
        </div>
        <div className="os-row" style={{ gap: 10, alignItems: 'center' }}>
          {letter && (
            <button className="os-btn" onClick={() => { setLetter(null); setPending(null); setNotFound(null); }}>← SECTIONS</button>
          )}
          <button className="os-btn" disabled={!!reportedAt} onClick={() => { setRepOpen(true); }}>
            {reportedAt ? `REPORT SUBMITTED ${reportedAt}` : 'RAPPORT DE FIN'}
          </button>
          <button className="os-btn os-btn--primary" onClick={() => setScannerOpen(true)}>OPEN SCANNER</button>
        </div>
      </div>

      {/* ================= HOME: header counters + dynamic sections ====== */}
      {!letter ? (
        <div className="ts-home">
          {home && (
            <div className="ts-metrics">
              <div className="ts-metric">
                <span className="ts-metric-v">{home.header.activeProducts}</span>
                <span className="ts-metric-l">ACTIVE PRODUCTS</span>
              </div>
              <div className="ts-metric is-ok">
                <span className="ts-metric-v">{home.header.completed}</span>
                <span className="ts-metric-l">STORED</span>
              </div>
              <div className="ts-metric">
                <span className="ts-metric-v">{home.header.remaining}</span>
                <span className="ts-metric-l">REMAINING</span>
              </div>
              <div className={home.header.review > 0 ? 'ts-metric is-err' : 'ts-metric'}>
                <span className="ts-metric-v">{home.header.review}</span>
                <span className="ts-metric-l">IN REVIEW</span>
              </div>
              <div className="ts-metric">
                <span className="ts-metric-v">{home.header.containers}</span>
                <span className="ts-metric-l">CONTAINERS</span>
              </div>
            </div>
          )}

          {home && home.sections.length > 0 ? (
            <div className="ts-sections">
              {home.sections.map((s) => (
                <button type="button" key={s.letter} className="ts-sec" onClick={() => openSection(s.letter)}>
                  <span className="ts-sec-top">
                    <span className={`ts-sec-letter${s.letter === home.currentSection ? ' is-amber' : ''}`}>{s.letter}</span>
                    <span>
                      <span className="ts-sec-name">SECTION {s.letter}</span>
                      {s.letter === home.currentSection && (
                        <span className="os-tag os-tag--warn" style={{ marginLeft: 8 }}>ACTIVE TARGET</span>
                      )}
                      <br />
                      <span className="os-muted">{s.products} units · {s.customers.length} customer{s.customers.length === 1 ? '' : 's'}</span>
                    </span>
                  </span>
                  <span className="ts-sec-customers">
                    {s.customers.map((c) => (
                      <span key={c.customer} className="ts-sec-cust">
                        {c.customer} <b>{c.remaining}</b>
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="os-empty">
              {home ? 'NO ACTIVE SECTION — nothing confirmed for Temporary Storage yet.' : 'Loading station…'}
            </div>
          )}
        </div>
      ) : (
        /* ================= BOARD: section letter + container grid ======= */
        <div className="ts-home">
          <div className="fl-decision is-ok" style={{ marginBottom: 4 }}>
            <div className="fl-decision-row" style={{ alignItems: 'center', gap: 16 }}>
              <div className="fl-decision-k">SECTION</div>
              <div className="fl-decision-v ok">{letter}</div>
              {board && board.reviewItems.length > 0 && (
                <span className="os-tag os-tag--err">{board.reviewItems.length} REVIEW</span>
              )}
            </div>
          </div>

          {board && board.customers.length > 0 && (
            <div className="ts-groups">
              {board.customers.map((c) => (
                <section key={c.customer} className="ts-group">
                  <header className="ts-group-head">
                    <span className="ts-group-name">
                      {c.customer} <small>{c.surname ?? ''}</small>
                    </span>
                    {c.hasReview && <span className="os-tag os-tag--err">REVIEW</span>}
                    <span className="ts-group-meta">
                      <span>RECEIVED <b>{c.received}</b></span>
                      <span>STORED <b>{c.stored}</b></span>
                      <span>LEFT <b>{c.remaining}</b></span>
                    </span>
                  </header>
                  <div className="ts-ctrs">
                    {c.containers.map((k) => {
                      const statusCls = k.status.toLowerCase();
                      const pct = k.capacity > 0 ? Math.min(100, Math.round((k.current / k.capacity) * 100)) : 0;
                      return (
                        <div key={k.code} className={`ts-ctr is-${statusCls}${targetCls(k.code)}${flashCls(k.code)}`}>
                          {highlight === k.code && pending && <span className="ts-ctr-badge">▶ PLACE HERE</span>}
                          <span className="ts-ctr-code">{k.code}</span>
                          <span className="ts-ctr-bar"><i style={{ width: `${pct}%` }} /></span>
                          <span className="ts-ctr-meta">
                            <span><b>{k.current}</b>/{k.capacity}</span>
                            <span className="ts-ctr-status">{k.status}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
          {board && board.customers.length === 0 && (
            <div className="os-empty">No active customer batch in this section.</div>
          )}
        </div>
      )}

      {/* =============== scan input + decision ============================ */}
      {pending && (
        <div className="fl-decision is-ok">
          <div className="fl-decision-k">TARGET CONTAINER — SCAN IT NOW</div>
          <div className="fl-decision-row" style={{ alignItems: 'center' }}>
            <div className="fl-decision-v ok">{pending.target.code}</div>
            {pending.target.mustCreate && <span className="os-tag os-tag--warn">NEW CONTAINER</span>}
          </div>
          <div className="os-muted">
            {pending.customer} {pending.surname ?? ''} · SECTION {pending.section} · {pending.remaining} unit(s) left
            {pending.target.capacity > 0 && ` · capacity ${pending.target.current}/${pending.target.capacity}`}
          </div>
        </div>
      )}
      {notFound && (
        <div className="fl-decision is-err">
          <div className="fl-decision-k">UNKNOWN CODE</div>
          <div className="fl-decision-v err">{notFound.code}</div>
          <div className="os-muted">No confirmed product matches this scan. Send it to the Review lane (admin alerted) or re-scan.</div>
          <div className="os-row" style={{ gap: 10, marginTop: 10 }}>
            <button type="button" className="os-btn os-btn--danger" disabled={busy} onClick={() => void sendToReview()}>
              SEND TO REVIEW
            </button>
            <button type="button" className="os-btn" disabled={busy} onClick={() => setNotFound(null)}>RESCAN</button>
          </div>
        </div>
      )}
      {pending && pending.target.mustCreate && (
        <div className="ts-hint">
          <span>▶ CONTAINER <b>{pending.target.code}</b> DOES NOT EXIST YET — the system creates it when you scan this code.</span>
        </div>
      )}

      <div className="fl-input">
        <label className="os-label" htmlFor="ts-scan-field">
          {pending ? `SCAN OR TYPE CONTAINER ${pending.target.code}` : 'SCAN OR TYPE PRODUCT'}
        </label>
        <div className="os-row">
          <input
            id="ts-scan-field"
            ref={inputRef}
            className="os-input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const v = manual; setManual(''); void submit(v); }
            }}
            placeholder={pending ? `SCAN CONTAINER ${pending.target.code}` : 'scan product code…'}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
          <button className="os-btn" disabled={busy || !manual.trim()} onClick={() => { const v = manual; setManual(''); void submit(v); }}>
            ENTER
          </button>
          {pending && (
            <button className="os-btn" disabled={busy} onClick={() => { setPending(null); setNotFound(null); push('scan cleared', 'info'); }}>
              CANCEL
            </button>
          )}
        </div>
      </div>

      {outcome && !scannerOpen && (
        <div key={outcome.token} className={`fl-outcome fl-outcome--${outcome.kind}`}>
          {outcome.kind === 'ok' ? '✓ ' : outcome.kind === 'bad' ? '✕ ' : '▸ '}{outcome.text}
        </div>
      )}

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

      {/* REVIEW lane of the section (if any) */}
      {board && board.reviewItems.length > 0 && (
        <section className="os-card">
          <h2 className="os-card-title">REVIEW LANE — {board.reviewItems.length} ITEM(S)</h2>
          <div className="ts-reviews">
            {board.reviewItems.map((r) => (
              <div key={r.id} className="ts-review">
                <span className="ts-review-k">REVIEW</span>
                <span className="ts-review-main">
                  <b>{r.productName ?? r.reference ?? r.sku ?? 'unknown'}</b>
                  {r.customerName ? ` · ${r.customerName}` : ''}
                  <div className="ts-review-reason">{r.reason ?? 'no reason'}</div>
                </span>
                <span className="os-muted">{new Date(r.scannedAt).toLocaleTimeString()} · {r.scannedBy ?? '—'}</span>
              </div>
            ))}
          </div>
          <p className="os-muted" style={{ marginTop: 8 }}>Supervisor/admin resolves these from the Admin Exception Center.</p>
        </section>
      )}

      {/* Rapport de Fin */}
      {repOpen && (
        <section className="ts-report">
          <h3>RAPPORT DE FIN — send today&apos;s storage summary to Admin → Reports</h3>
          <textarea
            className="os-input"
            rows={2}
            style={{ width: '100%', resize: 'vertical' }}
            value={repObs}
            onChange={(e) => setRepObs(e.target.value)}
            placeholder="Observation (optional) — sections processed, exceptions, notes…"
          />
          <div className="os-row" style={{ gap: 10, marginTop: 8 }}>
            <button type="button" className="os-btn os-btn--primary" disabled={busy || !!reportedAt} onClick={() => void submitRapport()}>
              {reportedAt ? `SUBMITTED AT ${reportedAt}` : 'SUBMIT RAPPORT DE FIN'}
            </button>
            <button type="button" className="os-btn" onClick={() => setRepOpen(false)}>CLOSE</button>
          </div>
        </section>
      )}

      {scannerOpen && (
        <Suspense fallback={<div className="os-empty">STARTING SCANNER…</div>}>
          <ContinuousScanner
            title={pending ? `PLACE IN ${pending.target.code} — SCAN CONTAINER` : 'SCAN PRODUCT'}
            enableOcr={ocrAllowed}
            outcome={outcome}
            onDetected={(value) => { void submit(value); }}
            onClose={() => { setScannerOpen(false); setOutcome(null); }}
          />
        </Suspense>
      )}
    </div>
  );
}
