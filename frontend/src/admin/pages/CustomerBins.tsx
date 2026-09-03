import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, type ContainerBoardRow } from '../api';

/**
 * CUSTOMER BINS (COMMAND #1 FINAL §12) — per-order operational containers.
 * Article count is live; expected count is the units requested on the
 * linked order. Sorting worker derives from the ITEM_PICKED audit trail.
 */
export default function CustomerBins() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ContainerBoardRow[] | null>(null);
  const [filter, setFilter] = useState('ALL'); // ALL | ACTIVE | READY_FOR_PACKING | PACKED | CLOSED
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      setRows(await adminApi.customerBins());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load customer bins.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    if (!rows) return null;
    if (filter === 'ALL') return rows;
    return rows.filter((c) => c.status === filter);
  }, [rows, filter]);

  const counts = useMemo(() => {
    if (!rows) return null;
    const pick = (s: string) => rows.filter((c) => c.status === s).length;
    return { ALL: rows.length, ACTIVE: pick('ACTIVE'), READY_FOR_PACKING: pick('READY_FOR_PACKING'), PACKED: pick('PACKED'), CLOSED: pick('CLOSED') };
  }, [rows]);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Customer Bins</h1>
          <p className="ac-sub">
            Article → Customer → Order → Bin · expected vs present counts are live ·
            order completeness is decided by the backend, never the UI.
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()} disabled={busy}>
          {busy ? '…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="os-card">
        <div className="cc-head">
          <div className="os-row" style={{ flexWrap: 'wrap' }}>
            {(['ALL', 'ACTIVE', 'READY_FOR_PACKING', 'PACKED', 'CLOSED'] as const).map((f) => (
              <button key={f} className={`os-btn${filter === f ? ' os-btn--primary' : ''}`} onClick={() => setFilter(f)}>
                {f.replace(/_/g, ' ')} {counts ? `(${counts[f]})` : ''}
              </button>
            ))}
          </div>
        </div>

        {!rows ? (
          <div className="os-empty">loading bins…</div>
        ) : !visible || visible.length === 0 ? (
          <div className="os-empty">No customer bins match.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr><th>Bin</th><th>Customer</th><th>Order</th><th>Articles</th><th>Expected</th><th>Status</th><th>Worker</th><th>Created</th><th /></tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td className="mono">{c.label ?? c.order?.customer ?? '—'}</td>
                    <td className="mono">{c.order?.reference ?? '—'}</td>
                    <td className="mono">{c.count}</td>
                    <td className="mono">{c.expected ?? <span className="os-muted">—</span>}</td>
                    <td>
                      {c.status === 'READY_FOR_PACKING'
                        ? <span className="os-tag os-tag--warn">READY FOR PACKING</span>
                        : c.status === 'PACKED'
                          ? <span className="os-tag os-tag--ok">PACKED</span>
                          : c.status === 'CLOSED'
                            ? <span className="os-tag os-tag--muted">CLOSED</span>
                            : <span className="os-tag os-tag--ok">OPEN</span>}
                    </td>
                    <td>{c.worker?.name ?? <span className="os-muted">—</span>}</td>
                    <td className="os-muted">{new Date(c.createdAt).toLocaleString()}</td>
                    <td>
                      <button className="ac-linkbtn mono" onClick={() => navigate(`/admin/containers/${c.code}`)}>
                        details
                      </button>
                    </td>
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
