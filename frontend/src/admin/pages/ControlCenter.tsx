import { useNavigate } from 'react-router-dom';
import { useControlData } from '../controlData';
import type { ActivityEvent, ExceptionRowLight, MetricCell, OpsOverview } from '../api';

/** Metric cell colour semantics (§10) — no green-for-everything. */
const CELL_TONE: Record<string, string> = {
  active: 'tone-ok',
  waiting: 'tone-warn',
  attention: 'tone-warn',
  ready: 'tone-warn',
  blocked: 'tone-err',
  exceptions: 'tone-err',
  done: 'tone-ok',
  info: 'tone-info',
};
const CELL_LABEL: Record<string, string> = {
  active: 'ACTIVE',
  waiting: 'WAITING',
  attention: 'ATTENTION',
  ready: 'READY',
  blocked: 'BLOCKED',
  done: 'DONE',
  exceptions: 'EXCEPTIONS',
  info: '',
};

function metricLabel(c: MetricCell) {
  const base = CELL_LABEL[c.key] ?? c.key;
  if (c.key === 'exceptions' && c.unit === 'open') return 'OPEN EXCEPTIONS';
  if (c.key === 'info') return c.unit.toUpperCase();
  return c.unit ? `${base} ${c.unit.toUpperCase()}` : base;
}

function prettyAction(a: string) {
  return a.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** OPERATION PIPELINE — one flow box per stage (§4B). */
export function Pipeline({ stages }: { stages: OpsOverview['pipeline'] }) {
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title">Operation Pipeline</h2>
        <span className="os-muted" style={{ fontSize: 12 }}>arrival → … → archive / trace · real counts only · no category gate</span>
      </div>
      <div className="ac-pipe">
        {stages.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'stretch' }}>
            {i > 0 && <div className="ac-pipe-arrow">▸</div>}
            <div className="ac-stage">
              <div className="ac-stage-idx">0{i + 1}</div>
              <div className="ac-stage-title">{s.title}</div>
              <div className="ac-stage-cells">
                {s.cells.map((c) => (
                  <div key={c.key} className="ac-metric">
                    <span className={`ac-metric-value ${CELL_TONE[c.key] ?? 'tone-info'}`}>{c.value}</span>
                    <span className="ac-metric-label">{metricLabel(c)}</span>
                  </div>
                ))}
                {s.cells.length === 0 && <span className="os-muted" style={{ fontSize: 11 }}>not available</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** §5 — current operations with [OPEN]. */
export function OperationsPanel({ operations }: { operations: OpsOverview['operations'] }) {
  const navigate = useNavigate();
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title">Operations</h2>
        <span className="os-muted" style={{ fontSize: 12 }}>live operational panels</span>
      </div>
      <div className="ac-scroll">
        <table className="os-table">
          <thead>
            <tr><th>Operation</th><th>Status</th><th>Current</th><th>Attention</th><th>Detail</th><th /></tr>
          </thead>
          <tbody>
            {operations.map((op) => (
              <tr key={op.id}>
                <td><span className="op-title">{op.title}</span>
                  {op.cells.length > 0 && (
                    <div className="ac-ops-metrics">
                      {op.cells.map((c) => `${c.value} ${c.unit}`).join(' · ')}
                    </div>
                  )}
                </td>
                <td><span className={`os-tag ${op.status.tone === 'ok' ? 'os-tag--ok' : op.status.tone === 'warn' ? 'os-tag--warn' : 'os-tag--muted'}`}>{op.status.label}</span></td>
                <td><span className="ac-ops-count">{op.current}</span></td>
                <td>
                  {op.attention > 0
                    ? <span className="ac-ops-count ac-ops-count--attention">{op.attention}</span>
                    : <span className="os-muted">0</span>}
                </td>
                <td className="ac-ops-metrics">{op.cells.map((c) => metricLabel(c)).join(' · ') || '—'}</td>
                <td>
                  {op.open ? (
                    <button className="os-btn" onClick={() => navigate(op.open as string)}>OPEN</button>
                  ) : (
                    <button className="os-btn" disabled title="no dedicated screen yet">OPEN</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** §6 — workers. */
export function WorkersPanel({ o }: { o: OpsOverview }) {
  const navigate = useNavigate();
  const onTask = o.workers.filter((w) => w.activeTask).length;
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title">Workers <span className="tone-ok">{onTask} on task</span> / {o.workers.length} active</h2>
        <span className="os-muted" style={{ fontSize: 12 }}>idle · on task · offline/blocked: not tracked in V1</span>
      </div>
      <div className="ac-scroll">
        <table className="os-table">
          <thead>
            <tr><th>Worker</th><th>Role</th><th>Current task</th><th>Station</th><th>Status</th><th>Last activity</th></tr>
          </thead>
          <tbody>
            {o.workers.map((w) => (
              <tr key={w.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/workers/${w.id}`)}>
                <td>
                  <span className="mono">{w.employeeCode}</span> · {w.name}
                </td>
                <td className="os-muted">{w.roles[0] ?? '—'}</td>
                <td className="mono">{w.activeTask ? `${w.activeTask.kind === 'PUTAWAY' ? 'PUTAWAY' : 'RECEIVING'} ${w.activeTask.code}` : <span className="os-muted">—</span>}</td>
                <td className="mono">{w.station?.code ?? <span className="os-muted">unassigned</span>}</td>
                <td>
                  {w.activeTask
                    ? <span className="os-tag os-tag--ok">● ON TASK</span>
                    : <span className="os-tag os-tag--muted">○ IDLE</span>}
                </td>
                <td className="os-muted">{fmtAgo(w.lastActivityAt)}</td>
              </tr>
            ))}
            {o.workers.length === 0 && <tr><td colSpan={6} className="os-empty">No active workers.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** §7 — stations. */
export function StationsPanel({ o }: { o: OpsOverview }) {
  const tag = (s: string) =>
    s === 'ACTIVE' ? <span className="os-tag os-tag--ok">🟢 {s}</span>
      : s === 'MAINTENANCE' ? <span className="os-tag os-tag--warn">🟡 {s}</span>
        : <span className="os-tag os-tag--muted">⚪ {s}</span>;
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title">Stations <span className="os-muted">{o.counters.activeStations}/{o.counters.stations} active</span></h2>
        <span className="os-muted" style={{ fontSize: 12 }}>ATTENTION/BLOCKED/OFFLINE are not station statuses in V1</span>
      </div>
      <div className="ac-scroll">
        <table className="os-table">
          <thead><tr><th>Station</th><th>Type</th><th>Worker</th><th>Current task</th><th>Status</th></tr></thead>
          <tbody>
            {o.stations.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.code}</td>
                <td className="os-muted">{s.department}</td>
                <td>{s.worker?.name ?? <span className="os-muted">unassigned</span>}</td>
                <td className="mono">{s.workerTask ?? <span className="os-muted">—</span>}</td>
                <td>{tag(s.status)}</td>
              </tr>
            ))}
            {o.stations.length === 0 && <tr><td colSpan={5} className="os-empty">No stations configured.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** §8 — open exceptions summary. */
export function ExceptionsPanel({ o }: { o: OpsOverview }) {
  const navigate = useNavigate();
  const sev = o.exceptions.bySeverity;
  const recent = o.exceptions.recent.slice(0, 8);
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title">Open Exceptions <span className="tone-err">{o.exceptions.open}</span></h2>
        <button className="os-btn" onClick={() => navigate('/admin/exceptions')}>EXCEPTION CENTER</button>
      </div>
      <div className="sev-grid">
        {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((s) => (
          <div key={s} className={`sev-cell sev--${s}`}>
            <div className="sev-num">{sev[s]}</div>
            <div className="sev-label">{s}</div>
          </div>
        ))}
      </div>
      {recent.length === 0 ? (
        <div className="os-empty">No open exceptions.</div>
      ) : (
        <div className="ac-scroll">
          <table className="os-table">
            <thead>
              <tr><th>Type</th><th>Sev.</th><th>Context</th><th>Worker</th><th>Raised</th><th /></tr>
            </thead>
            <tbody>
              {recent.map((x) => <ExcRow key={x.id} x={x} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExcRow({ x }: { x: ExceptionRowLight }) {
  const navigate = useNavigate();
  return (
    <tr>
      <td className="mono">{x.type.replace(/_/g, ' ')}</td>
      <td><span className={`os-tag os-tag--sev-${x.severity.toLowerCase()}`}>{x.severity}</span></td>
      <td className="os-muted" style={{ maxWidth: 260 }}>
        {x.reason ?? (x.session?.arrival ? `arrival ${x.session.arrival.code}` : '—')}
      </td>
      <td>{x.worker?.name ?? '—'}</td>
      <td className="os-muted">{fmtAgo(x.createdAt)}</td>
      <td>
        {x.session && (
          <button className="ac-linkbtn mono" onClick={() => navigate(`/admin/sessions/${x.session!.id}`)}>
            open
          </button>
        )}
      </td>
    </tr>
  );
}

/** §9 — live activity stream. */
export function ActivityPanel({ events }: { events: ActivityEvent[] }) {
  const navigate = useNavigate();
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title"><span className="live-dot live-dot--ok" />Live Activity</h2>
        <button className="os-btn" onClick={() => navigate('/admin/activity')}>VIEW ALL</button>
      </div>
      {events.length === 0 ? (
        <div className="os-empty">No operational events recorded yet.</div>
      ) : (
        <div className="ac-activity">
          {events.map((e) => (
            <div key={e.id} className="ac-ev">
              <span className="ac-ev-time">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className="ac-ev-entity">{e.entity ?? <span className="ac-na">—</span>}</span>
              <span className="ac-ev-action">→ {prettyAction(e.action)}</span>
              <span className="ac-ev-worker">{e.worker?.name ?? '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Warehouse status line (§4A). */
export function WarehouseStatus({ o }: { o: OpsOverview }) {
  const onTask = o.workers.filter((w) => w.activeTask).length;
  const running =
    o.counters.activeSessions > 0 ||
    o.counters.activePutawaySessions > 0 ||
    o.counters.openOrders > 0 ||
    onTask > 0;
  const state = o.exceptions.open > 0
    ? { label: 'ATTENTION REQUIRED', tone: 'tone-err' }
    : running
      ? { label: 'OPERATIONS LIVE', tone: 'tone-ok' }
      : { label: 'OPERATIONAL · STANDBY', tone: 'tone-info' };
  return (
    <div className="os-card">
      <div className="cc-head">
        <h2 className="cc-title">Warehouse Status</h2>
        <span className={`ac-sub ${state.tone}`} style={{ margin: 0 }}>
          <span className="live-dot live-dot--ok" />
          {state.label}
        </span>
      </div>
      <div className="ac-statusline">
        <div className="ac-status-cell">
          <div className="ac-kpi-value mono">{o.warehouse?.code ?? '—'}</div>
          <div className="ac-kpi-label">Warehouse · {o.warehouse?.name ?? 'not configured'}</div>
        </div>
        <div className="ac-status-cell">
          <div className="ac-kpi-value tone-ok">● ONLINE</div>
          <div className="ac-kpi-label">System status</div>
        </div>
        <div className="ac-status-cell">
          <div className="ac-kpi-value">{onTask}<span className="os-muted" style={{ fontSize: 12 }}> / {o.workers.length}</span></div>
          <div className="ac-kpi-label">Active workers</div>
        </div>
        <div className="ac-status-cell">
          <div className="ac-kpi-value">{o.counters.activeStations}<span className="os-muted" style={{ fontSize: 12 }}> / {o.counters.stations}</span></div>
          <div className="ac-kpi-label">Active stations</div>
        </div>
        <div className="ac-status-cell">
          <div className={`ac-kpi-value ${o.exceptions.open > 0 ? 'tone-err' : 'tone-ok'}`}>{o.exceptions.open}</div>
          <div className="ac-kpi-label">Open exceptions</div>
        </div>
      </div>
    </div>
  );
}

export default function ControlCenter() {
  const { overview, loading, error, lastUpdated, reload } = useControlData();

  if (loading && !overview) return <div className="os-empty">loading control room…</div>;
  if (!overview) {
    return error
      ? <div className="ac-error">{error}</div>
      : <div className="os-empty">no data</div>;
  }
  const o = overview;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Control Center</h1>
          <p className="ac-sub">
            Warehouse control room · refreshed{' '}
            {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '…'} · auto every 30s
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void reload()}>Refresh</button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <WarehouseStatus o={o} />

      <section className="cc-section">
        <Pipeline stages={o.pipeline} />
      </section>

      <section className="cc-section">
        <OperationsPanel operations={o.operations} />
      </section>

      <div className="ac-2col">
        <WorkersPanel o={o} />
        <StationsPanel o={o} />
      </div>

      <div className="ac-2col">
        <ExceptionsPanel o={o} />
        <ActivityPanel events={o.activity} />
      </div>
    </>
  );
}
