import { Navigate, useNavigate } from 'react-router-dom';
import { useTerminalUi } from './WorkerShell';

/**
 * Worker Terminal home (spec §3).
 *
 * Routing policy:
 *   - exactly one ready task -> skip this screen entirely and open it, so the
 *     worker does not have to "find" their job (§2),
 *   - several ready tasks    -> show the picker below,
 *   - none                   -> say so plainly. A worker with no permitted
 *     task is NEVER redirected into the admin dashboard (§2/§46).
 */
export default function WorkerTerminalHome() {
  const { ctx } = useTerminalUi();
  const navigate = useNavigate();

  const tasks = ctx?.tasks ?? [];
  const ready = tasks.filter((t) => t.ready);

  // Single permitted task: go straight to work.
  if (ready.length === 1) return <Navigate to={ready[0].path} replace />;

  // Resume an interrupted session before anything else.
  const resume = ctx?.activeSession;

  if (tasks.length === 0) {
    return (
      <div className="wt-center">
        <div className="wt-empty">
          <h1>NO TASK ASSIGNED</h1>
          <p className="os-muted">
            Your account has no operational task permissions yet. Ask a supervisor to assign you a
            role or a station.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wt-home">
      <h1 className="wt-home-title">SELECT TASK</h1>
      <p className="os-muted wt-home-sub">
        {ctx?.station
          ? `Station ${ctx.station.code} · ${ctx.station.name}`
          : 'No station assigned to you'}
      </p>

      {resume && (
        <button
          type="button"
          className="wt-resume"
          onClick={() => navigate('/terminal/receiving')}
        >
          <span className="os-tag os-tag--warn">IN PROGRESS</span>
          <strong>Resume session {resume.code}</strong>
          <span className="os-muted">
            {resume.expectedArrival?.code} · {resume.expectedArrival?.customerName}
          </span>
        </button>
      )}

      <div className="wt-tasks">
        {tasks.map((t) => (
          <button
            key={t.key}
            type="button"
            className="wt-task-card"
            disabled={!t.ready}
            onClick={() => navigate(t.path)}
          >
            <span className="wt-task-name">{t.label}</span>
            <span className="wt-task-dept os-muted">{t.department}</span>
            <span className={`os-tag ${t.ready ? 'os-tag--ok' : 'os-tag--muted'}`}>
              {t.ready ? 'OPEN' : 'SOON'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
