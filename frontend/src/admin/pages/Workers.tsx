import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from '../api';
import { useAsync } from './useAsync';
import { LoadingState, StatusBadge, PageHeader, Button } from '../../ui';

/** Worker list + drill-down into their sessions (§37). */
export default function Workers() {
  const { id } = useParams();
  return id ? <WorkerDetail id={id} /> : <WorkerList />;
}

function WorkerList() {
  const { data, loading, error } = useAsync(() => adminApi.workers(), []);
  const navigate = useNavigate();

  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Workers</h1>
        <p className="ac-sub">Floor staff, their station and today's activity.</p>
      </header>
      {error && <div className="ac-error">{error}</div>}
      <section className="os-card">
        {loading && !data ? <LoadingState /> : (
          <table className="os-table">
            <thead>
              <tr><th>Name</th><th>Code</th><th>Roles</th><th>Station</th><th>Sessions today</th><th /></tr>
            </thead>
            <tbody>
              {(data ?? []).map((w) => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td className="mono">{w.employeeCode}</td>
                  <td className="os-muted">{w.roles.join(', ') || '—'}</td>
                  <td>{w.station
                    ? <span className="os-tag os-tag--info">{w.station.code}</span>
                    : <span className="os-muted">unassigned</span>}</td>
                  <td>{w.sessionsToday}</td>
                  <td>
                    <button className="ac-linkbtn" onClick={() => navigate(`/admin/workers/${w.id}`)}>
                      inspect
                    </button>
                  </td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={6} className="os-empty">No active workers.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function WorkerDetail({ id }: { id: string }) {
  const { data, loading, error } = useAsync(() => adminApi.worker(id), [id]);
  const navigate = useNavigate();

  if (loading && !data) return <LoadingState label="Loading worker…" block />;
  if (error) return <div className="ac-error">{error}</div>;
  if (!data) return null;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">{data.worker.name}</h1>
          <p className="ac-sub">
            {data.worker.employeeCode} · {data.worker.roles.join(', ')} ·{' '}
            {data.worker.station ? `Station ${data.worker.station.code}` : 'no station'}
          </p>
        </div>
        <Button icon="back" onClick={() => navigate('/admin/workers')}>Back</Button>
      </header>

      <section className="os-card">
        <h2 className="os-card-title">Sessions</h2>
        <table className="os-table">
          <thead>
            <tr><th>Session</th><th>Arrival</th><th>Started</th><th>Status</th><th>Cartons</th><th>Exc.</th><th /></tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.code}</td>
                <td>{s.arrival?.code ?? '—'}</td>
                <td className="os-muted">{new Date(s.startedAt).toLocaleString()}</td>
                <td><StatusBadge status={s.status} /></td>
                <td>{s.counts.cartons}</td>
                <td>{s.counts.discrepancies > 0
                  ? <span className="os-tag os-tag--err">{s.counts.discrepancies}</span>
                  : <span className="os-muted">0</span>}</td>
                <td>
                  <button className="ac-linkbtn" onClick={() => navigate(`/admin/sessions/${s.id}`)}>
                    operations
                  </button>
                </td>
              </tr>
            ))}
            {data.sessions.length === 0 && <tr><td colSpan={7} className="os-empty">No sessions yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="os-card" style={{ marginTop: 14 }}>
        <h2 className="os-card-title">Putaway sessions</h2>
        <table className="os-table">
          <thead>
            <tr><th>Session</th><th>Station</th><th>Started</th><th>Status</th><th>Placements</th></tr>
          </thead>
          <tbody>
            {data.putawaySessions.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.code}</td>
                <td className="os-muted">{p.stationCode ?? '—'}</td>
                <td className="os-muted">{new Date(p.startedAt).toLocaleString()}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td>{p.placements}</td>
              </tr>
            ))}
            {data.putawaySessions.length === 0 && (
              <tr><td colSpan={5} className="os-empty">No stowing yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
