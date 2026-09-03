import { useState } from 'react';
import { adminApi } from '../api';
import { useAsync } from './useAsync';

/**
 * CONTAINERS (Admin CC V1 §3 WAREHOUSE group) — operational containers:
 * RECEIVING totes and CUSTOMER bins, from the existing fulfillment API.
 */
const FILTERS = ['ALL', 'RECEIVING', 'CUSTOMER'] as const;

function statusTag(status: string) {
  switch (status) {
    case 'READY_FOR_PACKING': return 'os-tag--warn';
    case 'PACKED': return 'os-tag--ok';
    case 'CLOSED': return 'os-tag--muted';
    default: return 'os-tag--info'; // ACTIVE
  }
}

export default function Containers() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const { data, loading, error, reload } = useAsync(
    () => adminApi.containers(filter === 'ALL' ? undefined : { type: filter }),
    [filter],
  );

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Containers</h1>
          <p className="ac-sub">Receiving totes and customer bins on the floor.</p>
        </div>
        <button type="button" className="os-btn" onClick={() => void reload()}>REFRESH</button>
      </header>
      {error && <div className="ac-error">{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={`os-btn${filter === f ? ' os-btn--primary' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <section className="os-card">
        {loading && !data ? <div className="os-empty">loading containers…</div>
          : (data ?? []).length === 0 ? <div className="os-empty">No containers found.</div> : (
            <table className="os-table">
              <thead>
                <tr>
                  <th>Code</th><th>Type</th><th>Label</th><th>Order</th>
                  <th>Articles</th><th>Status</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((ct) => (
                  <tr key={ct.id}>
                    <td className="mono">{ct.code}</td>
                    <td className="os-muted">{ct.type}</td>
                    <td>{ct.label ?? <span className="os-muted">—</span>}</td>
                    <td className="os-muted mono">{ct.order?.externalOrderReference ?? '—'}</td>
                    <td>{ct._count.articles}</td>
                    <td><span className={`os-tag ${statusTag(ct.status)}`}>{ct.status.replace(/_/g, ' ')}</span></td>
                    <td className="os-muted">{new Date(ct.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
    </>
  );
}
