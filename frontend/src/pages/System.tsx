import { useFetch } from '../hooks/useFetch';

interface Setting { key: string; value: Record<string, unknown>; description: string | null }

export default function System() {
  const { data: settings, loading, error } = useFetch<Setting[]>('/v1/system/settings');
  const { data: health } = useFetch<any>('/v1/system/health');
  const { data: apiClients, loading: cLoading, error: cError } = useFetch<any[]>('/v1/system/api-clients');

  return (
    <>
      <h1 className="page-title">System Settings</h1>
      <p className="page-sub">Core configuration and API clients. Integration boundary is only contracts in Phase 0.</p>

      <div className="grid2">
        <div className="card">
          <h3>Health</h3>
          {health ? (
            <ul style={{ color: 'var(--text-dim)' }}>
              <li>Status: <strong style={{ color: 'var(--success)' }}>{health.status}</strong></li>
              <li>Version: {health.version} · Phase: {health.phase}</li>
              <li>Database: {health.database}</li>
              <li>Build commit: <strong className="mono">{health.build?.commitShort ?? '—'}</strong></li>
              <li>SPA asset: <span className="mono">{health.build?.spaAsset ?? '—'}</span></li>
              <li>Built at: {health.build?.builtAt ? new Date(health.build.builtAt).toLocaleString() : '—'}</li>
            </ul>
          ) : <p className="empty">Loading…</p>}
        </div>

        <div className="card">
          <h3>System settings</h3>
          {loading && <p className="empty">Loading…</p>}
          {error && <div className="error-box">{error}</div>}
          {!loading && (settings ?? []).length === 0 && <p className="empty">No settings stored yet.</p>}
          {!loading && (settings ?? []).map((s) => (
            <div key={s.key} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div><strong>{s.key}</strong></div>
              <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>{JSON.stringify(s.value)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>API clients</h3>
        {cLoading && <p className="empty">Loading…</p>}
        {cError && <div className="error-box">{cError}</div>}
        {!cLoading && (apiClients ?? []).length === 0 && <p className="empty">No API clients yet.</p>}
        {!cLoading && (apiClients ?? []).map((c) => (
          <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <strong>{c.name}</strong> <span className="tag accent">{c.clientId.slice(0, 8)}…</span>{' '}
            <span className={`tag ${c.status === 'ACTIVE' ? 'green' : 'red'}`}>{c.status}</span>
          </div>
        ))}
      </div>
    </>
  );
}
