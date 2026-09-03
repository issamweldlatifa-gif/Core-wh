import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTerminalUi } from './WorkerShell';
import { terminalApi, type TerminalAssignment } from './api';

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
 *
 * COMMAND #3 — Worker Control: an admin can attach concrete assigned tasks to
 * a specific worker ("receive order/arrival X, then report back"). These are
 * shown above the picker; each is independently completable with a note so the
 * admin sees proof of work, not just an empty promise.
 */
export default function WorkerTerminalHome() {
  const { ctx, setStatus } = useTerminalUi();
  const navigate = useNavigate();

  const [assign, setAssign] = useState<{ open: TerminalAssignment[]; recent: TerminalAssignment[] } | null>(null);
  const [assignLoaded, setAssignLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    terminalApi
      .assignments()
      .then((d) => {
        if (alive) setAssign(d);
      })
      .catch(() => {
        if (alive) setAssign({ open: [], recent: [] });
      })
      .finally(() => {
        if (alive) setAssignLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const tasks = ctx?.tasks ?? [];
  const ready = tasks.filter((t) => t.ready);
  const openAssign = assign?.open ?? [];

  // Work already in flight beats any default routing: send the worker back to
  // exactly what they were doing, whichever task it was.
  const resume = ctx?.resume ?? null;
  if (resume) return <Navigate to={resume.path} replace />;

  // Wait for the assigned-tasks fetch before auto-routing, so an admin-issued
  // task is never skipped by the "single ready task" shortcut (COMMAND #3).
  if (!assignLoaded) {
    return (
      <div className="wt-center">
        <div className="wt-empty">
          <h1 className="os-muted">…</h1>
        </div>
      </div>
    );
  }

  const finish = async (a: TerminalAssignment) => {
    setBusy(a.id);
    try {
      await terminalApi.completeAssignment(a.id);
      setStatus({ text: `DONE — ${a.title}`, kind: 'ok' });
      setAssign((p) =>
        p ? { open: p.open.filter((x) => x.id !== a.id), recent: [{ ...a, status: 'DONE' }, ...p.recent] } : p,
      );
    } catch {
      setStatus({ text: 'could not complete assigned task', kind: 'bad' });
    } finally {
      setBusy(null);
    }
  };

  // A pending assigned task takes the floor before the one-click shortcut, so
  // the worker sees it on entry (they can still open their regular task below).
  if (openAssign.length === 0 && ready.length === 1) return <Navigate to={ready[0].path} replace />;

  const hasAnyTask = tasks.length > 0 || openAssign.length > 0;

  if (!hasAnyTask) {
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
      <h1 className="wt-home-title">{tasks.length ? 'SELECT TASK' : 'MY TASKS'}</h1>
      <p className="os-muted wt-home-sub">
        {ctx?.station
          ? `Station ${ctx.station.code} · ${ctx.station.name}`
          : 'No station assigned to you'}
      </p>

      {openAssign.length > 0 && (
        <section className="wt-assigned">
          <h2 className="wt-assigned-title">ASSIGNED TASKS</h2>
          <ul className="wt-assigned-list">
            {openAssign.map((a) => (
              <li key={a.id} className="wt-assigned-item">
                <div className="wt-assigned-main">
                  <span className="wt-assigned-title-text">
                    {a.title}
                    {a.relatedCode ? (
                      <span className="os-tag os-tag--warn wt-assigned-rel">{a.relatedCode}</span>
                    ) : null}
                  </span>
                  {a.description ? <span className="wt-assigned-desc os-muted">{a.description}</span> : null}
                </div>
                <button type="button" className="wt-assigned-done" disabled={busy === a.id} onClick={() => finish(a)}>
                  {busy === a.id ? '…' : 'DONE'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tasks.length > 0 && (
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
                  <span className="os-tag os-tag--warn">IN PROGRESS · {openCode}</span>
                ) : (
                  <span className={`os-tag ${t.ready ? 'os-tag--ok' : 'os-tag--muted'}`}>
                    {t.ready ? 'OPEN' : 'SOON'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
