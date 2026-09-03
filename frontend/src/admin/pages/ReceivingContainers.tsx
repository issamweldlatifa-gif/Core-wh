import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, type ContainerBoardRow } from '../api';

/**
 * RECEIVING CONTAINERS / TOTES (COMMAND #1 FINAL §08) — the operational
 * buffer unit, front and centre. Real rows only; FULL is derived server-side
 * from the configurable capacity (never a hardcoded 50 in the UI).
 */
export default function ReceivingContainers() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ContainerBoardRow[] | null>(null);
  const [filter, setFilter] = useState('ALL'); // ALL | ACTIVE | FULL | CLOSED
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      setRows(await adminApi.receivingContainers());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load receiving containers.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    if (!rows) return null;
    if (filter === 'ALL') return rows;
    return rows.filter((c) => (filter === 'FULL' ? c.status === 'FULL' : c.status === filter));
  }, [rows, filter]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      ALL: rows.length,
      ACTIVE: rows.filter((c) => c.status === 'ACTIVE').length,
      FULL: rows.filter((c) => c.status === 'FULL').length,
      CLOSED: rows.filter((c) => c.status === 'CLOSED').length,
    };
  }, [rows]);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Receiving Containers / Totes</h1>
          <p className="ac-sub">
            Operational buffers on the receiving line · capacity configurable on the container ·
            count / capacity and status are live.
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
            {(['ALL', 'ACTIVE', 'FULL', 'CLOSED'] as const).map((f) => (
              <button key={f} className={`os-btn${filter === f ? ' os-btn--primary' : ''}`} onClick={() => setFilter(f)}>
                {f} {counts ? `(${counts[f]})` : ''}
              </button>
            ))}
          </div>
        </div>

        {!rows ? (
          <div className="os-empty">loading containers…</div>
        ) : !visible || visible.length === 0 ? (
          <div className="os-empty">No receiving containers match.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr><th>Container</th><th>Status</th><th>Capacity</th><th>Worker</th><th>Station</th><th>Created</th><th>Last activity</th><th /></tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td>
                      {c.status === 'FULL'
                        ? <span className="os-tag os-tag--err">FULL</span>
                        : c.status === 'CLOSED'
                          ? <span className="os-tag os-tag--muted">CLOSED</span>
                          : <span className="os-tag os-tag--ok">ACTIVE</span>}
                    </td>
                    <td>
                      <span className="mono">{c.count} / {c.capacity}</span>
                      {c.fill != null && <span className="os-muted" style={{ marginLeft: 6, fontSize: 11 }}>{c.fill}%</span>}
                    </td>
                    <td>{c.worker?.name ?? <span className="os-muted">—</span>}</td>
                    <td className="mono">{c.station?.code ?? <span className="os-muted">—</span>}</td>
                    <td className="os-muted">{new Date(c.createdAt).toLocaleString()}</td>
                    <td className="os-muted">
                      {c.lastActivity ? new Date(c.lastActivity).toLocaleString() : '—'}
                    </td>
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
