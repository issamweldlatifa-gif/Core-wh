import { useCallback, useEffect, useRef, useState } from 'react';
import { fulfillmentApi, type SortingScanResult } from './fulfillment-api';
import { beepSuccess, beepError, beepInfo } from '../modules/receiving-terminal/feedback';
import { useTerminalUi } from './WorkerShell';
import './flow-task.css';

/**
 * SORTING + STORAGE terminal (§26 loop: SCAN -> SYSTEM DECISION -> ACTION ->
 * CONFIRMATION -> NEXT ITEM).
 *
 * Step 1: scan the ARTICLE  -> the system resolves Category -> configured
 *         destination zone and shows concrete free locations.
 * Step 2: scan the LOCATION -> the backend validates the zone and confirms
 *         STORED. A wrong-zone scan is rejected server-side.
 */

type Step = 'ARTICLE' | 'LOCATION';

export default function SortingTask() {
  const { setStatus, setLastAction } = useTerminalUi();

  const [step, setStep] = useState<Step>('ARTICLE');
  const [decision, setDecision] = useState<SortingScanResult | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string; token: number } | null>(null);
  const [stored, setStored] = useState(0);
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

  useEffect(() => {
    setStatus(step === 'ARTICLE'
      ? { text: 'SCAN ARTICLE', kind: 'info' }
      : { text: 'SCAN LOCATION', kind: 'ok' });
  }, [step, setStatus]);

  const submit = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (step === 'ARTICLE') {
        const res = await fulfillmentApi.sortingScan(value);
        setDecision(res);
        if (res.kind === 'DESTINATION') {
          setStep('LOCATION');
          report('info', `${res.article.sku} → ZONE ${res.zone.code} — SCAN LOCATION`);
          push(`${res.article.code} → ${res.zone.code}`, 'info');
        } else if (res.kind === 'NEEDS_REVIEW') {
          report('bad', `${res.article.sku} — MANUAL REVIEW REQUIRED`);
          push(`${res.article.code} needs category review`, 'bad');
        } else if (res.kind === 'REJECTED') {
          report('bad', res.reason);
          push(res.reason, 'bad');
        } else {
          report('bad', res.kind === 'UNMAPPED' ? 'NO DESTINATION CONFIGURED' : 'MULTIPLE DESTINATIONS CONFIGURED');
          push(`${res.article.code}: mapping ${res.kind}`, 'bad');
        }
        return;
      }
      // LOCATION step
      if (!decision || decision.kind !== 'DESTINATION') { setStep('ARTICLE'); return; }
      const res = await fulfillmentApi.sortingStore({
        articleCode: decision.article.code,
        locationCode: value,
      });
      report('ok', `${res.flash.article} STORED AT ${res.flash.location}`);
      push(`${res.flash.article} → ${res.flash.location}`, 'ok');
      setStored((n) => n + 1);
      setDecision(null);
      setStep('ARTICLE');
    } catch (e: any) {
      const m = e?.response?.data?.message ?? 'Server error';
      report('bad', Array.isArray(m) ? m.join(', ') : String(m));
      push(String(Array.isArray(m) ? m.join(', ') : m), 'bad');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, step, decision, report, push]);

  const dest = decision?.kind === 'DESTINATION' ? decision : null;

  return (
    <div className="fl">
      <div className="fl-bar">
        <div>
          <h1 className="fl-h1">SORTING</h1>
          <p className="fl-sub">Article → configured destination → storage location.</p>
        </div>
        <div className="fl-metric is-ok" style={{ padding: '8px 16px' }}>
          <div className="fl-metric-v">{stored}</div>
          <div className="fl-metric-l">STORED</div>
        </div>
      </div>

      <div className="fl-steps">
        <div className={`fl-step${step === 'ARTICLE' ? ' is-active' : ''}${dest ? ' is-done' : ''}`}>
          <div className="fl-step-n">1</div>
          <div>
            <div className="fl-step-t">ARTICLE</div>
            <div className="fl-step-v">{dest ? `${dest.article.code} · ${dest.article.sku}` : '— scan an article —'}</div>
            {dest && (
              <div className="os-muted">
                {dest.article.productName ?? ''} · {dest.article.category}
                {dest.article.subcategory ? ` / ${dest.article.subcategory}` : ''}
              </div>
            )}
          </div>
        </div>
        <div className={`fl-step${step === 'LOCATION' ? ' is-active' : ''}`}>
          <div className="fl-step-n">2</div>
          <div>
            <div className="fl-step-t">LOCATION</div>
            <div className="fl-step-v">{step === 'LOCATION' ? '— scan the shelf —' : 'waiting for article'}</div>
          </div>
        </div>
      </div>

      {/* SYSTEM DECISION — where this article must go. */}
      {dest && (
        <div className="fl-decision">
          <div className="fl-decision-k">PUT IT IN ZONE</div>
          <div className="fl-decision-v ok">{dest.zone.code} — {dest.zone.name}</div>
          {dest.suggestedLocations.length > 0 && (
            <div className="fl-decision-row">
              <span className="fl-decision-k">FREE LOCATIONS:</span>
              {dest.suggestedLocations.map((l) => (
                <span key={l} className="os-mono">{l}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {decision?.kind === 'NEEDS_REVIEW' && (
        <div className="fl-decision is-err">
          <div className="fl-decision-k">CATEGORY</div>
          <div className="fl-decision-v err">NEEDS REVIEW — MANUAL REVIEW REQUIRED</div>
          <div className="os-muted">Hand this article to a supervisor. It cannot be stored until the category is confirmed.</div>
        </div>
      )}
      {(decision?.kind === 'UNMAPPED' || decision?.kind === 'AMBIGUOUS') && (
        <div className="fl-decision is-warn">
          <div className="fl-decision-k">DESTINATION CONFIGURATION</div>
          <div className="fl-decision-v warn">
            {decision.kind === 'UNMAPPED' ? 'NO DESTINATION CONFIGURED' : 'MULTIPLE DESTINATIONS CONFIGURED'}
          </div>
          <div className="os-muted">An admin must fix the Category → Zone mapping. Nothing is guessed.</div>
        </div>
      )}

      <div className="fl-input">
        <label className="os-label" htmlFor="fl-sort-field">
          {step === 'ARTICLE' ? 'SCAN OR TYPE ARTICLE CODE' : 'SCAN OR TYPE LOCATION'}
        </label>
        <div className="os-row">
          <input
            id="fl-sort-field"
            ref={inputRef}
            className="os-input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const v = manual; setManual(''); void submit(v); }
            }}
            placeholder={step === 'ARTICLE' ? 'ART-…' : 'TUN-MAIN-…'}
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
          {dest && (
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

      {outcome && (
        <div key={outcome.token} className={`fl-outcome fl-outcome--${outcome.kind}`}>
          {outcome.kind === 'ok' ? '✓ ' : outcome.kind === 'bad' ? '✕ ' : ''}{outcome.text}
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
    </div>
  );
}
