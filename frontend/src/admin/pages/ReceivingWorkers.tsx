import { useEffect, useMemo, useState } from 'react';
import { adminApi, type ReceivingWorkerRow } from '../api';

/**
 * RECEIVING WORKERS — the worker activity report of the card-based receiving
 * flow. One row per physical operation (scan / confirm / reject) with:
 * Who (worker), What (task, card, card type), How (operation, identifier
 * type + value, source), Result (MATCH / MISMATCH / DUPLICATE / AMBIGUOUS),
 * When (date + time) and for how long (duration), on which Device.
 *
 * Data source: the backend ReceivingWorkerLog written atomically with every
 * receiving state change — the device-side matching verdict is only the
 * advisory input, the backend confirmation is what is recorded here.
 */

const CARD_TYPES = ['ALL', 'PRODUCT', 'CARTON'] as const;
const RESULTS = ['ALL', 'MATCH', 'MISMATCH', 'DUPLICATE', 'AMBIGUOUS'] as const;

function resultTag(r: ReceivingWorkerRow['result']): { cls: string; label: string } {
  switch (r) {
    case 'MATCH': return { cls: 'os-tag--ok', label: 'MATCH' };
    case 'MISMATCH': return { cls: 'os-tag--err', label: 'MISMATCH' };
    case 'DUPLICATE': return { cls: 'os-tag--warn', label: 'DUPLICATE' };
    case 'AMBIGUOUS': return { cls: 'os-tag--info', label: 'AMBIGUOUS' };
    default: return { cls: 'os-tag--muted', label: r };
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export default function ReceivingWorkers() {
  const [rows, setRows] = useState<ReceivingWorkerRow[] | null>(null);
  const [cardType, setCardType] = useState<(typeof CARD_TYPES)[number]>('ALL');
  const [result, setResult] = useState<(typeof RESULTS)[number]>('ALL');
  const [workerQuery, setWorkerQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      setRows(await adminApi.receivingWorkers({
        cardType: cardType === 'ALL' ? undefined : cardType,
        result: result === 'ALL' ? undefined : result,
      }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load receiving worker report.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [cardType, result]);

  const visible = useMemo(() => {
    if (!rows) return null;
    const q = workerQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.worker, r.workerCode, r.session, r.arrival, r.card, r.identifierValue]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [rows, workerQuery]);

  const summary = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      match: rows.filter((r) => r.result === 'MATCH').length,
      mismatch: rows.filter((r) => r.result === 'MISMATCH').length,
      duplicate: rows.filter((r) => r.result === 'DUPLICATE').length,
      ambiguous: rows.filter((r) => r.result === 'AMBIGUOUS').length,
    };
  }, [rows]);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Receiving Workers</h1>
          <p className="ac-sub">
            Worker activity for the card-based receiving flow · PRODUCT and CARTON card
            operations · every row is a logged scan / confirm / reject with identifier,
            result, duration and device.
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()} disabled={busy}>
          {busy ? '…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="os-card">
        <div className="cc-head">
          <div className="os-row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="os-row" style={{ gap: 6 }}>
              {CARD_TYPES.map((f) => (
                <button key={f} className={`os-btn${cardType === f ? ' os-btn--primary' : ''}`} onClick={() => setCardType(f)}>
                  {f === 'ALL' ? 'ALL CARDS' : `${f} CARD`}
                </button>
              ))}
            </div>
            <div className="os-row" style={{ gap: 6 }}>
              {RESULTS.map((f) => (
                <button key={f} className={`os-btn${result === f ? ' os-btn--primary' : ''}`} onClick={() => setResult(f)}>
                  {f}
                </button>
              ))}
            </div>
            <input
              className="os-input"
              style={{ maxWidth: 260 }}
              placeholder="Filter worker / card / identifier…"
              value={workerQuery}
              onChange={(e) => setWorkerQuery(e.target.value)}
            />
          </div>
        </div>

        {summary && (
          <div className="os-row" style={{ flexWrap: 'wrap', gap: 14, padding: '8px 0' }}>
            <span className="os-muted">
              {summary.total} operations ·{' '}
              <span style={{ color: 'var(--success)' }}>{summary.match} MATCH</span> ·{' '}
              <span style={{ color: 'var(--error)' }}>{summary.mismatch} MISMATCH</span> ·{' '}
              <span style={{ color: 'var(--warning)' }}>{summary.duplicate} DUPLICATE</span> ·{' '}
              <span style={{ color: 'var(--info)' }}>{summary.ambiguous} AMBIGUOUS</span>
            </span>
          </div>
        )}

        {!rows ? (
          <div className="os-empty">loading receiving worker report…</div>
        ) : !visible || visible.length === 0 ? (
          <div className="os-empty">No receiving operations match.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Worker ID</th>
                  <th>Task</th>
                  <th>Card</th>
                  <th>Card Type</th>
                  <th>Operation</th>
                  <th>Identifier Type</th>
                  <th>Identifier Value</th>
                  <th>Result</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Duration</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const res = resultTag(r.result);
                  return (
                    <tr key={r.id}>
                      <td>{r.worker ?? '—'}{r.workerCode ? <span className="os-muted"> · {r.workerCode}</span> : null}</td>
                      <td className="mono os-muted">{r.workerId ?? '—'}</td>
                      <td className="mono">
                        {r.task ?? '—'}
                        {r.session ? <span className="os-muted"> · {r.session}</span> : null}
                      </td>
                      <td className="mono">{r.card ?? '—'}</td>
                      <td>
                        <span className={`os-tag ${r.cardType === 'PRODUCT' ? 'os-tag--info' : 'os-tag--warn'}`}>
                          {r.cardType}
                        </span>
                      </td>
                      <td className="mono">{r.operation}</td>
                      <td className="mono">{r.identifierType}</td>
                      <td className="mono">{r.identifierValue}</td>
                      <td><span className={`os-tag ${res.cls}`}>{res.label}</span></td>
                      <td className="os-muted">{r.date}</td>
                      <td className="mono">{r.time}</td>
                      <td className="mono">{fmtDuration(r.durationMs)}</td>
                      <td className="mono">
                        {r.device ?? '—'}{r.deviceName ? <span className="os-muted"> · {r.deviceName}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
