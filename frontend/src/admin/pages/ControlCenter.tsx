import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api';
import { useAsync } from './useAsync';
import { Kpi, LoadingState, PageHeader, StatusBadge, Button, EmptyState } from '../../ui';

/** Live operational overview (§36). */
export default function ControlCenter() {
  const { data, loading, error, reload } = useAsync(() => adminApi.overview(), []);
  const navigate = useNavigate();

  if (loading && !data) return <LoadingState label="Loading operations…" block />;
  if (error) return <div className="ac-error">{error}</div>;
  if (!data) return null;

  const c = data.counters;
  return (
    <>
      <PageHeader
        title="Control Center"
        sub={`Live floor state · refreshed ${new Date(data.generatedAt).toLocaleTimeString()}`}
        actions={<Button icon="refresh" onClick={() => void reload()}>Refresh</Button>}
      />

      <div className="ac-kpis">
        <Kpi label="Active sessions" value={c.activeSessions} tone={c.activeSessions ? 'ok' : undefined} />
        <Kpi label="Open exceptions" value={c.openExceptions} tone={c.openExceptions ? 'bad' : undefined} />
        <Kpi label="Cartons today" value={c.cartonsReceivedToday} />
        <Kpi label="Sessions today" value={c.todaySessions} />
        <Kpi label="Expected arrivals" value={c.expectedArrivals} />
        <Kpi label="Corrections today" value={c.correctionsToday} tone={c.correctionsToday ? 'alert' : undefined} />
        <Kpi label="Active stations" value={`${c.activeStations}/${c.stations}`} />
        <Kpi label="Awaiting putaway" value={c.awaitingPutaway} tone={c.awaitingPutaway ? 'alert' : undefined} />
        <Kpi label="Stored today" value={c.cartonsStoredToday} />
      </div>

      <div className="ac-2col">
        <section className="os-card">
          <h2 className="os-card-title">Active receiving sessions</h2>
          {data.activeSessions.length === 0 ? (
            <EmptyState icon="scan" title="No session in progress" hint="Receiving sessions appear here while workers work." />
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
            <EmptyState icon="station" title="No stations configured" hint="Create stations to assign workers and hardware." />
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
                      <StatusBadge status={s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="os-card" style={{ marginTop: 14 }}>
        <h2 className="os-card-title">Active putaway sessions</h2>
        {data.putawaySessions.length === 0 ? (
          <EmptyState icon="package" title="No stowing in progress" hint="Putaway sessions appear here while workers stow cartons." />
        ) : (
          <table className="os-table">
            <thead>
              <tr><th>Session</th><th>Worker</th><th>Station</th><th>Placements</th><th>Started</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.putawaySessions.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.code}</td>
                  <td>{p.worker?.name ?? '—'}</td>
                  <td className="os-muted">{p.stationCode ?? '—'}</td>
                  <td>{p.placements}</td>
                  <td className="os-muted">{new Date(p.startedAt).toLocaleTimeString()}</td>
                  <td>
                    <StatusBadge status={p.status} />
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
