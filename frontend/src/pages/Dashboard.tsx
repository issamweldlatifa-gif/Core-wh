import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { terminalApi, type TerminalContext } from '../terminal/api';
import { adminApi, type OpsOverview } from '../admin/api';
import { useAsync } from '../admin/pages/useAsync';
import './dashboard.css';

/**
 * DASHBOARD = Monitor + Navigate (UX rule). It NEVER rebuilds an operational
 * workspace: for every module it shows only live STATUS + the door into the
 * real workspace (e.g. Receiving status + [OPEN RECEIVING]).
 *
 * ONE layout, ROLE-AWARE content:
 *   - operations.view holders -> system status, operational metrics, alerts,
 *     live sessions (recent activity) and administrative actions.
 *   - workers                -> current task, operational status, expected
 *     work and the primary action into their workspace.
 * Identity, roles, logout and permission dumps are NOT shown here — they live
 * in the global header (compact) and /profile (detail).
 */
export default function Dashboard() {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('operations.view');

  return isAdmin ? <AdminDashboard /> : <WorkerDashboard />;
}

/* ============================== WORKER ==================================== */
function WorkerDashboard() {
  const { data, loading, error, reload } = useAsync<TerminalContext>(() => terminalApi.context(), []);
  const { hasPermission } = useAuth();

  const tasks = data?.tasks ?? [];
  const ready = tasks.filter((t) => t.ready);
  const resume = data?.resume ?? null;
  const activeSession = data?.activeSession ?? null;
  const activePutaway = data?.activePutaway ?? null;
  const canReceive = hasPermission('receiving.execute');
  const canStow = hasPermission('stowing.execute');

  if (loading && !data) return <div className="card">loading your work…</div>;
  if (error) {
    return (
      <div className="card">
        Could not load work context: {error}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => void reload()}>
            ↻ RETRY
          </button>
        </div>
      </div>
    );
  }

  // Primary action: resume in-flight work first, else the single ready task,
  // else the first permitted module.
  const primary = resume ?? ready[0] ?? tasks[0] ?? null;
  const primaryLabel = primary ? ('label' in primary ? primary.label : primary.kind) : '';

  return (
    <div className="dash">
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Operational overview · {data?.station ? `station ${data.station.code}` : 'no station assigned'}</p>

      <div className="dash-hero">
        <div className="dash-hero-info">
          <div className="dash-kicker">CURRENT TASK</div>
          <div className="dash-hero-title">
            {activeSession
              ? `Receiving ${activeSession.code} in progress`
              : activePutaway
                ? `Putaway ${activePutaway.code} in progress`
                : resume
                  ? `Resume ${primaryLabel}`
                  : ready.length
                    ? `${ready[0].label} ready`
                    : 'No task in flight'}
          </div>
          <div className="dash-hero-sub">
            {activeSession?.expectedArrival
              ? `${activeSession.expectedArrival.code} · ${activeSession.expectedArrival.customerName}`
              : ready.length
                ? `${ready.length} task${ready.length > 1 ? 's' : ''} ready`
                : 'All clear — new work appears here'}
          </div>
        </div>
        {primary && (
          <Link to={primary.path} className="btn btn-primary dash-hero-cta">
            ▶ {resume || activeSession || activePutaway ? 'RESUME' : 'OPEN'} {primaryLabel.toUpperCase()}
          </Link>
        )}
      </div>

      <div className="dash-metrics">
        <Metric v={String(ready.length)} label="READY TASKS" />
        <Metric v={data?.station ? data.station.code : '—'} label="STATION" />
        <Metric v={activeSession ? activeSession.status : activePutaway ? activePutaway.status : 'IDLE'} label="SESSION STATE" />
      </div>

      <h3 className="dash-section">EXPECTED WORK</h3>
      <div className="grid2">
        {canReceive && (
          <ModuleCard
            title="Receiving"
            status={activeSession ? `IN PROGRESS · ${activeSession.code}` : ready.some((t) => t.key === 'receiving') ? 'READY' : 'ON HOLD'}
            tone={activeSession ? 'warn' : 'ok'}
            to="/terminal/receiving"
            action="OPEN RECEIVING"
            note="Physically receive expected arrivals: scan cartons, count product units, raise exceptions."
          />
        )}
        {canStow && (
          <ModuleCard
            title="Putaway / Stowing"
            status={activePutaway ? `IN PROGRESS · ${activePutaway.code}` : ready.some((t) => t.key === 'putaway') ? 'READY' : 'ON HOLD'}
            tone={activePutaway ? 'warn' : 'ok'}
            to="/terminal/putaway"
            action="OPEN PUTAWAY"
            note="Move received cartons to their assigned warehouse locations."
          />
        )}
        {!canReceive && !canStow && (
          <div className="card">
            <h3>No operational task</h3>
            <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>
              Your account has no operational task permissions yet. Ask a supervisor to assign you a role or station.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* =============================== ADMIN ==================================== */
function AdminDashboard() {
  const { data, loading, error, reload } = useAsync<OpsOverview>(() => adminApi.overview(), []);
  const { hasPermission } = useAuth();
  const canReceive = hasPermission('receiving.execute');
  const canStow = hasPermission('stowing.execute');

  if (loading && !data) return <div className="card">loading operations…</div>;
  if (error) {
    return (
      <div className="card">
        Could not load operations overview: {error}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => void reload()}>
            ↻ RETRY
          </button>
        </div>
      </div>
    );
  }
  if (!data) return null;
  const c = data.counters;

  return (
    <div className="dash">
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        System &amp; floor overview · refreshed {new Date(data.generatedAt).toLocaleTimeString()}
      </p>

      <div className="dash-hero">
        <div className="dash-hero-info">
          <div className="dash-kicker">SYSTEM STATUS</div>
          <div className="dash-hero-title">
            {c.activeSessions > 0 ? `${c.activeSessions} session${c.activeSessions > 1 ? 's' : ''} live on the floor` : 'Floor idle'}
          </div>
          <div className="dash-hero-sub">
            {c.openExceptions > 0
              ? `⚠ ${c.openExceptions} open exception${c.openExceptions > 1 ? 's' : ''} need attention`
              : 'No open exceptions'}
            {c.awaitingPutaway > 0 ? ` · ${c.awaitingPutaway} cartons awaiting putaway` : ''}
          </div>
        </div>
        {hasPermission('operations.view') && (
          <Link to="/admin" className="btn btn-primary dash-hero-cta">▶ OPEN CONTROL CENTER</Link>
        )}
      </div>

      <div className="dash-metrics">
        <Metric v={String(c.activeSessions)} label="ACTIVE SESSIONS" />
        <Metric v={String(c.cartonsReceivedToday)} label="CARTONS TODAY" />
        <Metric v={String(c.expectedArrivals)} label="EXPECTED ARRIVALS" />
        <Metric v={String(c.openExceptions)} label="OPEN EXCEPTIONS" tone={c.openExceptions ? 'bad' : undefined} />
        <Metric v={`${c.activeStations}/${c.stations}`} label="STATIONS UP" />
        <Metric v={String(c.awaitingPutaway)} label="AWAITING PUTAWAY" tone={c.awaitingPutaway ? 'warn' : undefined} />
      </div>

      {(canReceive || canStow) && (
        <>
          <h3 className="dash-section">OPERATIONAL WORKSPACES</h3>
          <div className="grid2">
            {canReceive && (
              <ModuleCard
                title="Receiving"
                status={c.activeSessions > 0 ? `${c.activeSessions} LIVE SESSION${c.activeSessions > 1 ? 'S' : ''}` : `${c.expectedArrivals} EXPECTED`}
                tone={c.activeSessions > 0 ? 'warn' : 'ok'}
                to="/terminal/receiving"
                action="OPEN RECEIVING"
                note="Physically receive expected arrivals: scan cartons, count product units, raise exceptions."
              />
            )}
            {canStow && (
              <ModuleCard
                title="Putaway / Stowing"
                status={c.awaitingPutaway > 0 ? `${c.awaitingPutaway} AWAITING` : 'CLEAR'}
                tone={c.awaitingPutaway > 0 ? 'warn' : 'ok'}
                to="/terminal/putaway"
                action="OPEN PUTAWAY"
                note="Move received cartons to their assigned warehouse locations."
              />
            )}
          </div>
        </>
      )}

      <div className="grid2">
        <div className="card">
          <h3>Live receiving activity</h3>
          {data.activeSessions.length === 0 ? (
            <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>No active sessions right now.</p>
          ) : (
            <ul className="dash-activity">
              {data.activeSessions.slice(0, 6).map((s) => (
                <li key={s.id}>
                  <span className="mono">{s.code}</span>
                  <span className="dash-activity-meta">
                    {s.arrival ? `${s.arrival.code} · ${s.arrival.customerName}` : '—'}
                    {' · '} {s.cartonEvents} carton{s.cartonEvents === 1 ? '' : 's'}
                    {s.discrepancies > 0 ? ` · ⚠ ${s.discrepancies} exc.` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h3>Administrative actions</h3>
          <div className="dash-actions">
            {hasPermission('operations.view') && <Link to="/admin" className="btn">Control Center</Link>}
            {hasPermission('users.view') && <Link to="/users" className="btn">Users</Link>}
            {hasPermission('roles.view') && <Link to="/roles" className="btn">Roles &amp; Permissions</Link>}
            {hasPermission('expected_arrivals.view') && <Link to="/expected-arrivals" className="btn">Expected Arrivals</Link>}
            {hasPermission('warehouses.view') && <Link to="/warehouse" className="btn">Warehouse</Link>}
            {hasPermission('audit.view') && <Link to="/audit" className="btn">Audit Log</Link>}
            {hasPermission('system.view') && <Link to="/system" className="btn">System Settings</Link>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================== SHARED ==================================== */
function Metric({ v, label, tone }: { v: string; label: string; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <div className={`dash-metric${tone ? ` is-${tone}` : ''}`}>
      <div className="dash-metric-v">{v}</div>
      <div className="dash-metric-l">{label}</div>
    </div>
  );
}

function ModuleCard({
  title, status, tone, to, action, note,
}: { title: string; status: string; tone: 'ok' | 'warn'; to: string; action: string; note: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <p style={{ color: 'var(--text-dim)', fontSize: 14 }}>{note}</p>
      <div style={{ margin: '8px 0 12px' }}>
        <span className={`tag ${tone === 'warn' ? '' : 'accent'}`}>{status}</span>
      </div>
      <Link to={to} className="btn btn-primary" style={{ textDecoration: 'none' }}>▶ {action}</Link>
    </div>
  );
}
