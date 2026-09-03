import { useNavigate } from 'react-router-dom';
import { useControlData } from '../controlData';
import { Pipeline, OperationsPanel } from './ControlCenter';

/**
 * Operations (§5) — full-page operational view: the complete pipeline plus
 * the live panels and any open receiving / putaway sessions. [OPEN] jumps to
 * the deepest real screen available.
 */
export default function Operations() {
  const { overview, loading, error, lastUpdated, reload } = useControlData();
  const navigate = useNavigate();

  if (loading && !overview) return <div className="os-empty">loading operations…</div>;
  if (!overview) {
    return error ? <div className="ac-error">{error}</div> : <div className="os-empty">no data</div>;
  }
  const o = overview;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Operations</h1>
          <p className="ac-sub">
            Operational panels and the full pipeline · refreshed {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '…'}
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void reload()}>Refresh</button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="cc-section"><Pipeline stages={o.pipeline} /></section>
      <section className="cc-section"><OperationsPanel operations={o.operations} /></section>

      <div className="ac-2col">
        <section className="os-card">
          <h2 className="os-card-title">Active receiving sessions</h2>
          {o.activeSessions.length === 0 ? (
            <div className="os-empty">No session in progress.</div>
          ) : (
            <table className="os-table">
              <thead>
                <tr><th>Session</th><th>Worker</th><th>Arrival</th><th>Cartons</th><th>Exc.</th><th /></tr>
              </thead>
              <tbody>
                {o.activeSessions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>{s.worker?.name ?? '—'}</td>
                    <td>{s.arrival?.code ?? '—'}</td>
                    <td>{s.cartonEvents}</td>
                    <td>
                      {s.discrepancies > 0
                        ? <span className="os-tag os-tag--err">{s.discrepancies}</span>
                        : <span className="os-muted">0</span>}
                    </td>
                    <td>
                      <button className="ac-linkbtn" onClick={() => navigate(`/admin/sessions/${s.id}`)}>
                        open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="os-card">
          <h2 className="os-card-title">Active putaway sessions</h2>
          {o.putawaySessions.length === 0 ? (
            <div className="os-empty">No stowing in progress.</div>
          ) : (
            <table className="os-table">
              <thead>
                <tr><th>Session</th><th>Worker</th><th>Station</th><th>Placements</th><th>Status</th></tr>
              </thead>
              <tbody>
                {o.putawaySessions.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.code}</td>
                    <td>{p.worker?.name ?? '—'}</td>
                    <td className="mono">{p.stationCode ?? '—'}</td>
                    <td>{p.placements}</td>
                    <td>
                      <span className={`os-tag ${p.status === 'ACTIVE' ? 'os-tag--ok' : 'os-tag--warn'}`}>{p.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}
