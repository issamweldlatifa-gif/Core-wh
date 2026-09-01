import { Navigate, useNavigate } from 'react-router-dom';
import { useTerminalUi } from './WorkerShell';

/**
 * Worker Terminal home (spec §3).
 *
 * Routing policy, in priority order:
 *   - work already in flight -> return to it, whichever task it belongs to,
 *     so a refresh or a dropped tab never loses the worker's place,
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

  // Work already in flight beats any default routing: send the worker back to
  // exactly what they were doing, whichever task it was.
  const resume = ctx?.resume ?? null;
  if (resume) return <Navigate to={resume.path} replace />;

  // Single permitted task: go straight to work.
  if (ready.length === 1) return <Navigate to={ready[0].path} replace />;

  if (tasks.length === 0) {
    return (
      <div className="wt-center">
        <div className="wt-empty">
          <h1>No task assigned</h1>
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
      <h1 className="wt-home-title">Select task</h1>
      <p className="os-muted wt-home-sub">
        {ctx?.station
          ? `Station ${ctx.station.code} · ${ctx.station.name}`
          : 'No station assigned to you'}
      </p>

      <div className="wt-tasks">
        {tasks.map((t) => {
          // Surface open work on the card itself, so the picker tells the
          // worker where they already have something running.
          const openCode =
            t.key === 'receiving' ? ctx?.activeSession?.code
            : t.key === 'putaway' ? ctx?.activePutaway?.code
            : undefined;
          return (
            <button
              key={t.key}
              type="button"
              className="wt-task-card"
              disabled={!t.ready}
              onClick={() => navigate(t.path)}
            >
              <span className="wt-task-name">{t.label}</span>
              <span className="wt-task-dept os-muted">{t.department}</span>
              {openCode ? (
                <span className="os-tag os-tag--warn">In progress · {openCode}</span>
              ) : (
                <span className={`os-tag ${t.ready ? 'os-tag--ok' : 'os-tag--muted'}`}>
                  {t.ready ? 'Open' : 'Soon'}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
