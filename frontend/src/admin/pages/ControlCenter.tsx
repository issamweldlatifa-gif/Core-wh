import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api';
import { useAsync } from './useAsync';

/** Live operational overview (§36). */
export default function ControlCenter() {
  const { data, loading, error, reload } = useAsync(() => adminApi.overview(), []);
  const navigate = useNavigate();

  if (loading && !data) return <div className="os-empty">loading operations…</div>;
  if (error) return <div className="ac-error">{error}</div>;
  if (!data) return null;

  const c = data.counters;
  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Control Center</h1>
          <p className="ac-sub">Live floor state · refreshed {new Date(data.generatedAt).toLocaleTimeString()}</p>
        </div>
        <button type="button" className="os-btn" onClick={() => void reload()}>Refresh</button>
      </header>

      <div className="ac-kpis">
        <Kpi label="Active sessions" value={c.activeSessions} tone={c.activeSessions ? 'ok' : undefined} />
        <Kpi label="Open exceptions" value={c.openExceptions} tone={c.openExceptions ? 'bad' : undefined} />
        <Kpi label="Cartons today" value={c.cartonsReceivedToday} />
        <Kpi label="Sessions today" value={c.todaySessions} />
        <Kpi label="Expected arrivals" value={c.expectedArrivals} />
        <Kpi label="Corrections today" value={c.correctionsToday} tone={c.correctionsToday ? 'alert' : undefined} />
        <Kpi label="Active stations" value={`${c.activeStations}/${c.stations}`} />
      </div>

      <div className="ac-2col">
        <section className="os-card">
          <h2 className="os-card-title">Active receiving sessions</h2>
          {data.activeSessions.length === 0 ? (
            <div className="os-empty">No session in progress.</div>
          ) : (
            <table className="os-table">
              <thead>
                <tr><th>Session</th><th>Worker</th><th>Arrival</th><th>Cartons</th><th>Exc.</th><th /></tr>
              </thead>
              <tbody>
                {data.activeSessions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>{s.worker?.name ?? '—'}</td>
                    <td>{s.arrival?.code ?? '—'}</td>
                    <td>{s.cartonEvents}</td>
                    <td>{s.discrepancies > 0
                      ? <span className="os-tag os-tag--err">{s.discrepancies}</span>
                      : <span className="os-muted">0</span>}</td>
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
          <h2 className="os-card-title">Stations</h2>
          {data.stations.length === 0 ? (
            <div className="os-empty">No stations configured.</div>
          ) : (
            <table className="os-table">
              <thead><tr><th>Code</th><th>Department</th><th>Worker</th><th>Status</th></tr></thead>
              <tbody>
                {data.stations.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td className="os-muted">{s.department}</td>
                    <td>{s.worker?.name ?? <span className="os-muted">unassigned</span>}</td>
                    <td>
                      <span className={`os-tag ${s.status === 'ACTIVE' ? 'os-tag--ok' : 'os-tag--muted'}`}>
                        {s.status}
                      </span>
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

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: 'ok' | 'bad' | 'alert' }) {
  return (
    <div className={`ac-kpi${tone ? ` ac-kpi--${tone}` : ''}`}>
      <div className="ac-kpi-value">{value}</div>
      <div className="ac-kpi-label">{label}</div>
    </div>
  );
}
