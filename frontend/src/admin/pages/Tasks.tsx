import { adminApi } from '../api';
import { useAsync } from './useAsync';

/**
 * Tasks (Workforce) — the canonical task registry with real floor numbers:
 * stations of the matching department, ACTIVE stations, workers holding the
 * execute permission, and any open receiving/putaway sessions. Numbers come
 * from the backend, never from the UI.
 */
export default function Tasks() {
  const { data, loading, error, reload } = useAsync(() => adminApi.tasks(), []);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Tasks</h1>
          <p className="ac-sub">
            Task registry that drives the worker terminal · execution screens live at /terminal
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void reload()}>Refresh</button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="os-card">
        {loading && !data ? (
          <div className="os-empty">loading tasks…</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr>
                  <th>Task</th><th>Department</th><th>Execute permission</th><th>Ready</th>
                  <th>Stations (active)</th><th>Workers w/ permission</th><th>Open work</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((t) => (
                  <tr key={t.key}>
                    <td>
                      <span className="mono">{t.key}</span>
                      <span className="os-muted" style={{ marginLeft: 8 }}>{t.path}</span>
                    </td>
                    <td className="os-muted">{t.department}</td>
                    <td className="mono os-muted">{t.permission}</td>
                    <td>
                      {t.ready
                        ? <span className="os-tag os-tag--ok">YES</span>
                        : <span className="os-tag os-tag--warn">FRAMEWORK ONLY</span>}
                    </td>
                    <td>{t.activeStations}<span className="os-muted"> / {t.stations}</span></td>
                    <td>{t.executors}</td>
                    <td>
                      {t.open !== null
                        ? t.open > 0
                          ? <span className="os-tag os-tag--info">{t.open} session{t.open === 1 ? '' : 's'}</span>
                          : <span className="os-tag os-tag--ok">0</span>
                        : <span className="os-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {data?.length === 0 && <tr><td colSpan={7} className="os-empty">No tasks registered.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <p className="os-muted" style={{ fontSize: 12, marginTop: 10 }}>
          Supervisor task-assignment screens are planned after the V1 Control Center is approved — the worker screens themselves are unchanged.
        </p>
      </section>
    </>
  );
}

