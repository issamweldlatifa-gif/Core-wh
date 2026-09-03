/**
 * TASKS (Admin CC V1 §3 WORKFORCE group) — honest placeholder.
 *
 * The task-assignment engine (worker roles → tasks → stations) is PHASE 2 of
 * the blueprint and starts only after Admin Control Center V1 is approved.
 * V1 shows no fake queues or invented assignments (§13): what exists today is
 * live session data, visible under Operations.
 */
import { NavLink } from 'react-router-dom';

export default function Tasks() {
  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Tasks</h1>
        <p className="ac-sub">Central task assignment for the floor workforce.</p>
      </header>

      <section className="os-card">
        <div className="os-empty" style={{ display: 'grid', gap: 10, padding: '28px 0' }}>
          <span className="os-tag os-tag--info" style={{ justifySelf: 'start' }}>NOT IMPLEMENTED — PHASE 2</span>
          <p style={{ margin: 0 }}>
            The task engine (roles → tasks → stations → worker screens) is scheduled
            for the phase after Control Center V1 approval. No task queue exists in
            the backend yet, so nothing is displayed here — this page will not show
            invented data.
          </p>
          <p style={{ margin: 0 }} className="os-muted">
            What is running right now on the floor is visible under{' '}
            <NavLink to="/admin/operations" className="ac-linkbtn" style={{ display: 'inline' }}>
              Operations
            </NavLink>.
          </p>
        </div>
      </section>
    </>
  );
}
