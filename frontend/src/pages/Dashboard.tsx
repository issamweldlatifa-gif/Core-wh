import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFetch } from '../hooks/useFetch';
import { adminApi, type OpsOverview } from '../admin/api';
import type { TerminalContext } from '../terminal/api';

/**
 * DASHBOARD = MONITOR + NAVIGATE (§ UX rules). It NEVER rebuilds a workspace.
 *
 * One layout, role-aware content (§7/§12):
 *   - seesOperations  -> admin/manager view: system status, operational
 *                        metrics, alerts, recent activity, admin actions.
 *   - operational worker -> current task, operational status, expected work
 *                        and PRIMARY ACTIONS that open the real workspaces.
 *
 * Identity, roles, logout and the permissions dump are NOT here anymore:
 * they live once in the Global Shell header and on /profile.
 */

interface Health { status: string; database: string }
interface AuditRow { id: string; action: string; actor: { name: string } | null; createdAt: string }

function Kpi({ value, label, tone }: { value: React.ReactNode; label: string; tone?: 'ok' | 'bad' | 'warn' }) {
  const color = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warning)' : tone === 'ok' ? 'var(--terminal-green)' : undefined;
  return (
    <div className="stat">
      <div className="stat-num" style={color ? { color } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** ADMIN / MANAGER content: monitor the operation, navigate to act. */
function AdminDashboard({ overview }: { overview: OpsOverview | null }) {
  const { hasPermission } = useAuth();
  const { data: health } = useFetch<Health>('/v1/system/health');
  const canAudit = hasPermission('audit.view');
  const { data: audit } = useFetch<AuditRow[]>(canAudit ? '/v1/audit?take=6' : null);
  const c = overview?.counters;

  return (
    <>
      <div className="stats-row">
        <Kpi value={health?.database === 'up' ? 'UP' : '…'} label="System status" tone={health?.database === 'up' ? 'ok' : 'warn'} />
        <Kpi value={c?.activeSessions ?? '—'} label="Active sessions" />
        <Kpi value={c?.openExceptions ?? '—'} label="Open exceptions" tone={(c?.openExceptions ?? 0) > 0 ? 'bad' : 'ok'} />
        <Kpi value={c?.expectedArrivals ?? '—'} label="Expected arrivals" />
        <Kpi value={c?.cartonsReceivedToday ?? '—'} label="Cartons today" />
        <Kpi value={c?.awaitingPutaway ?? '—'} label="Awaiting putaway" />
        <Kpi value={c?.correctionsToday ?? '—'} label="Corrections today" tone={(c?.correctionsToday ?? 0) > 0 ? 'warn' : undefined} />
      </div>

      {hasPermission('operations.view') && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0 }}>Control Center</h3>
              <p style={{ color: 'var(--text-dim)', margin: '6px 0 0' }}>
                Live operations: workers, stations, sessions, exceptions and corrections.
              </p>
            </div>
            <Link to="/admin" className="btn" style={{ textDecoration: 'none' }}>OPEN CONTROL CENTER</Link>
          </div>
        </div>
      )}

      <div className="grid2">
        {canAudit && (
          <div className="card">
            <h3>Recent activity</h3>
            {(audit ?? []).length === 0 && <p className="empty">No events.</p>}
            <table className="tight">
              <tbody>
                {(audit ?? []).map((a) => (
                  <tr key={a.id}>
                    <td><span className="tag accent">{a.action}</span></td>
                    <td className="muted">{a.actor?.name ?? 'system'}</td>
                    <td className="muted" style={{ textAlign: 'right' }}>{new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card">
          <h3>Administrative actions</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {hasPermission('users.view') && <Link to="/users" className="btn ghost">Users</Link>}
            {hasPermission('expected_arrivals.view') && <Link to="/expected-arrivals" className="btn ghost">Arrivals</Link>}
            {hasPermission('warehouses.view') && <Link to="/warehouse/structure" className="btn ghost">Warehouse</Link>}
            {hasPermission('audit.view') && <Link to="/audit" className="btn ghost">Audit</Link>}
            {hasPermission('system.view') && <Link to="/system" className="btn ghost">System</Link>}
          </div>
        </div>
      </div>
    </>
  );
}

/** WORKER content: what am I doing, what is waiting, one primary action. */
function WorkerDashboard() {
  const { hasPermission } = useAuth();
  const canExecute = hasPermission('receiving.execute') || hasPermission('stowing.execute');
  const { data: ctx } = useFetch<TerminalContext>(canExecute ? '/v1/terminal/context' : null);
  const canArrivals = hasPermission('expected_arrivals.view');
  const { data: arrivals } = useFetch<{ total: number }>(canArrivals ? '/v1/expected-arrivals?take=1' : null);

  const resume = ctx?.resume ?? null;
  const tasks = ctx?.tasks ?? [];

  return (
    <>
      <div className="card" style={{ borderColor: 'var(--accent)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0 }}>Current task</h3>
            <p style={{ color: 'var(--text-dim)', margin: '6px 0 0' }}>
              {resume
                ? `Session ${resume.code} is in progress — resume where you left off.`
                : 'No session in progress. Open a workspace to start.'}
            </p>
          </div>
          {resume && (
            <Link to={resume.path} className="btn" style={{ textDecoration: 'none' }}>RESUME {resume.kind}</Link>
          )}
        </div>
      </div>

      <div className="stats-row">
        {canArrivals && <Kpi value={arrivals?.total ?? '—'} label="Expected arrivals" />}
        {tasks.filter((t) => t.ready).length > 0 && (
          <Kpi value={tasks.filter((t) => t.ready).length} label="Open workspaces" tone="ok" />
        )}
        {tasks.some((t) => !t.ready) && (
          <Kpi value={tasks.filter((t) => !t.ready).length} label="Coming soon" tone="warn" />
        )}
      </div>

      {/* PRIMARY ACTIONS open the REAL workspaces — the dashboard never
          rebuilds them (§8/§9). */}
      <div className="card">
        <h3>Workspaces</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {hasPermission('receiving.execute') && (
            <Link to="/terminal/receiving" className="btn" style={{ textDecoration: 'none' }}>OPEN RECEIVING</Link>
          )}
          {hasPermission('stowing.execute') && (
            <Link to="/terminal/putaway" className="btn" style={{ textDecoration: 'none' }}>OPEN PUTAWAY</Link>
          )}
          {!canExecute && hasPermission('receiving.view') && (
            <Link to="/warehouse/receiving" className="btn" style={{ textDecoration: 'none' }}>OPEN RECEIVING TERMINAL</Link>
          )}
        </div>
      </div>
    </>
  );
}

export default function Dashboard() {
  const { hasPermission } = useAuth();
  const seesOperations = hasPermission('operations.view');
  const [overview, setOverview] = useState<OpsOverview | null>(null);

  useEffect(() => {
    if (!seesOperations) return;
    adminApi.overview().then(setOverview).catch(() => setOverview(null));
  }, [seesOperations]);

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        {seesOperations ? 'Operational overview of the warehouse.' : 'Your work at a glance.'}
      </p>
      {seesOperations ? <AdminDashboard overview={overview} /> : <WorkerDashboard />}
    </>
  );
}
