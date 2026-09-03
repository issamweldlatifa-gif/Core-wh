import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type ActivityRow } from '../api';

/**
 * LIVE ACTIVITY (Admin CC V1 §9) — the warehouse event stream.
 *
 * Source: the REAL audit log (/v1/audit). No invented events. V1 has no
 * WebSocket infrastructure, so this polls every 15 s and marks fresh rows.
 */
const REFRESH_MS = 15_000;

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Semantic tone per event family (§10 status colors). */
function toneOf(action: string): string {
  if (/EXCEPTION|DISCREPANC|FAILED|BLOCKED|REVERSED|DENIED/.test(action)) return 'os-tag--err';
  if (/CORRECTION|REVIEW|PAUSED|REOPENED/.test(action)) return 'os-tag--warn';
  if (/COMPLETED|CONFIRMED|STORED|PACKED|SHIPPED|VALIDATED|RESOLVED/.test(action)) return 'os-tag--ok';
  if (/STARTED|SCANNED|CREATED|RECEIVED|LOGIN|ASSIGNED/.test(action)) return 'os-tag--info';
  return 'os-tag--muted';
}

export default function LiveActivity() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const newestSeen = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi.activity(100);
      setRows(data);
      setError(null);
      if (data.length) newestSeen.current = data[0].createdAt;
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Failed to load activity stream.');
    }
  }, []);

  useEffect(() => {
    void load();
    if (paused) return;
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, paused]);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Live activity</h1>
          <p className="ac-sub">
            Warehouse event stream from the audit log · polled every {REFRESH_MS / 1000}s (no realtime infra in V1)
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="os-btn" onClick={() => setPaused((p) => !p)}>
            {paused ? 'RESUME' : 'PAUSE'}
          </button>
          <button type="button" className="os-btn" onClick={() => void load()}>REFRESH</button>
        </div>
      </header>
      {error && <div className="ac-error">{error}</div>}

      <section className="os-card">
        {!rows ? <div className="os-empty">loading events…</div>
          : rows.length === 0 ? <div className="os-empty">No recorded events.</div> : (
            <table className="os-table">
              <thead>
                <tr><th>Time</th><th>Event</th><th>Entity</th><th>Worker</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="mono os-muted">{fmtTime(e.createdAt)}</td>
                    <td><span className={`os-tag ${toneOf(e.action)}`}>{e.action.replace(/_/g, ' ')}</span></td>
                    <td className="os-muted">{e.entityType ?? '—'}</td>
                    <td>{e.actor
                      ? <>{e.actor.name} <span className="os-muted mono">{e.actor.employeeCode}</span></>
                      : <span className="os-muted">system</span>}</td>
                    <td className="os-muted mono" style={{ fontSize: '0.72rem', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.metadata ? summarize(e.metadata) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
    </>
  );
}

/** Compact one-line metadata summary; never dumps raw JSON walls. */
function summarize(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || typeof v === 'object') continue;
    parts.push(`${k}=${String(v)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' ') || '—';
}
