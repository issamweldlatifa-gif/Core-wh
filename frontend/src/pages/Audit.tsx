import { useFetch } from '../hooks/useFetch';

interface AuditRow {
  id: string; action: string; entityType: string | null; entityId: string | null;
  actor: { name: string; employeeCode: string } | null;
  createdAt: string; metadata: Record<string, unknown> | null;
}

function colorFor(action: string): string {
  if (action.startsWith('USER_LOGIN')) return 'green';
  if (action.includes('FAILED')) return 'red';
  if (action.startsWith('USER_LOGOUT')) return 'yellow';
  if (action.includes('CREATED') || action.includes('UPDATED') || action.includes('CHANGED')) return 'accent';
  return '';
}

export default function Audit() {
  const { data, loading, error } = useFetch<AuditRow[]>('/v1/audit?take=100');

  return (
    <>
      <h1 className="page-title">Audit Log</h1>
      <p className="page-sub">Immutable record of sensitive events (login, role & permission changes, user changes).</p>
      <div className="card">
        {loading && <p className="empty">Loading…</p>}
        {error && <div className="error-box">{error}</div>}
        {!loading && (data ?? []).length === 0 && <p className="empty">No audit events yet.</p>}
        {!loading && (data ?? []).length > 0 && (
          <table>
            <thead>
              <tr><th>Action</th><th>Actor</th><th>Entity</th><th>Detail</th><th>When</th></tr>
            </thead>
            <tbody>
              {(data ?? []).map((a) => (
                <tr key={a.id}>
                  <td><span className={`tag ${colorFor(a.action)}`}>{a.action}</span></td>
                  <td>{a.actor ? `${a.actor.name} (${a.actor.employeeCode})` : 'system'}</td>
                  <td>{a.entityType ?? '—'}{a.entityId ? ` · ${a.entityId.slice(0, 8)}` : ''}</td>
                  <td style={{ color: 'var(--text-dim)', maxWidth: 280 }}>
                    {a.metadata ? JSON.stringify(a.metadata) : '—'}
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
