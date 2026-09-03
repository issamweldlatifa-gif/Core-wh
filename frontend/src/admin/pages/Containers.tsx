import { useEffect, useState } from 'react';
import { adminApi, type ContainerRow } from '../api';

/**
 * Containers (Warehouse) — operational containers: RECEIVING totes and
 * CUSTOMER bins. Read-only board over the existing fulfillment containers
 * API; bin/tote lifecycle changes stay on the worker floor.
 */
const TYPE_TAG: Record<string, string> = { RECEIVING: 'os-tag--info', CUSTOMER: 'os-tag--ok' };
const STATUS_TAG: Record<string, string> = {
  ACTIVE: 'os-tag--muted',
  READY_FOR_PACKING: 'os-tag--warn',
  PACKED: 'os-tag--ok',
  CLOSED: 'os-tag--muted',
};

export default function Containers() {
  const [rows, setRows] = useState<ContainerRow[] | null>(null);
  const [type, setType] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const params: { type?: string; status?: string } = {};
      if (type !== 'ALL') params.type = type;
      if (status !== 'ALL') params.status = status;
      const data = await adminApi.containers(params);
      setRows(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load containers.');
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type, status]);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Containers</h1>
          <p className="ac-sub">Operational containers — RECEIVING totes (RCN-…) and CUSTOMER bins (BIN-…).</p>
        </div>
        <div className="os-row">
          {['ALL', 'RECEIVING', 'CUSTOMER'].map((t) => (
            <button key={t} className={`os-btn${type === t ? ' os-btn--primary' : ''}`} onClick={() => setType(t)}>{t}</button>
          ))}
          <span className="ac-top-sep" aria-hidden />
          {['ALL', 'ACTIVE', 'READY_FOR_PACKING', 'PACKED', 'CLOSED'].map((s) => (
            <button key={s} className={`os-btn${status === s ? ' os-btn--primary' : ''}`} onClick={() => setStatus(s)}>{s.replace(/_/g, ' ')}</button>
          ))}
        </div>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="os-card">
        {!rows ? (
          <div className="os-empty">loading containers…</div>
        ) : rows.length === 0 ? (
          <div className="os-empty">No containers match.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr><th>Code</th><th>Type</th><th>Status</th><th>Label</th><th>Order / Customer</th><th>Articles</th><th>Updated</th></tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td><span className={`os-tag ${TYPE_TAG[c.type] ?? 'os-tag--muted'}`}>{c.type}</span></td>
                    <td><span className={`os-tag ${STATUS_TAG[c.status] ?? 'os-tag--muted'}`}>{c.status.replace(/_/g, ' ')}</span></td>
                    <td>{c.label ?? <span className="os-muted">—</span>}</td>
                    <td className="mono">
                      {c.order
                        ? `${c.order.externalOrderReference} · ${c.order.externalCustomerReference}`
                        : <span className="os-muted">—</span>}
                    </td>
                    <td>{c._count.articles}</td>
                    <td className="os-muted">{new Date(c.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
