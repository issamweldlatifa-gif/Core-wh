import { useCallback, useEffect, useState } from 'react';
import { adminApi, type ActivityEvent } from '../api';

/**
 * Live Activity (§9) — real operational events from the audit trail.
 * No WebSocket is built in V1 (§9): a bounded 15s poll of the activity
 * endpoint keeps the board live without new realtime infrastructure.
 */

const EVENT_TONE: Record<string, string> = {
  UNKNOWN_CARTON: 'tone-err',
  WRONG_SHIPMENT: 'tone-err',
  UNEXPECTED_PRODUCT: 'tone-err',
  DISCREPANCY_CREATED: 'tone-err',
  DUPLICATE_CARTON: 'tone-warn',
  DISCREPANCY_RESOLVED: 'tone-warn',
  RECEIVING_PAUSED: 'tone-warn',
  PUTAWAY_PAUSED: 'tone-warn',
  ARTICLE_SCANNED: 'tone-info',
  ITEM_STORED: 'tone-ok',
  ITEM_MOVED: 'tone-ok',
  ITEM_PICKED: 'tone-ok',
  ORDER_PACKED: 'tone-ok',
  SHIPMENT_DISPATCHED: 'tone-ok',
};

function prettyAction(a: string) {
  return a.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
}

export default function Activity() {
  const [rows, setRows] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [last, setLast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi.activity(80);
      setRows(data);
      setLast(data[0]?.at ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const visible = (rows ?? []).filter((r) => filter === 'ALL' || r.action === filter);
  const actionCounts = new Map<string, number>();
  for (const r of rows ?? []) actionCounts.set(r.action, (actionCounts.get(r.action) ?? 0) + 1);
  const topActions = [...actionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a]) => a);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title"><span className="live-dot live-dot--ok" />Live Activity</h1>
          <p className="ac-sub">
            Operational events from the audit trail · polls every 15s{last ? ` · latest ${new Date(last).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()}>Refresh</button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="os-card">
        <div className="cc-head">
          <h2 className="cc-title">Event stream</h2>
          <div className="os-row" style={{ flexWrap: 'wrap' }}>
            <button className={`os-btn${filter === 'ALL' ? ' os-btn--primary' : ''}`} onClick={() => setFilter('ALL')}>ALL</button>
            {topActions.map((a) => (
              <button key={a} className={`os-btn${filter === a ? ' os-btn--primary' : ''}`} onClick={() => setFilter(a)}>
                {prettyAction(a)}
              </button>
            ))}
          </div>
        </div>

        {!rows ? (
          <div className="os-empty">loading activity…</div>
        ) : visible.length === 0 ? (
          <div className="os-empty">No events for this filter.</div>
        ) : (
          <div className="ac-activity" style={{ maxHeight: 'none' }}>
            {visible.map((e) => (
              <div key={e.id} className="ac-ev">
                <span className="ac-ev-time">{new Date(e.at).toLocaleString([], { hour12: false })}</span>
                <span className="ac-ev-entity">{e.entity ?? <span className="ac-na">—</span>}</span>
                <span className={`ac-ev-action ${EVENT_TONE[e.action] ?? ''}`}>→ {prettyAction(e.action)}</span>
                <span className="ac-ev-worker">{e.worker?.name ?? <span className="ac-na">—</span>}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
