import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { adminApi, WORKER_ROLE_OPTIONS, type WorkerRow, type WorkerTaskRow } from '../api';
import { useAsync } from './useAsync';

/**
 * Workers (WORKFORCE · Worker Control — COMMAND #3).
 *
 * One operational surface for floor staff:
 *   - per-worker presence: did they work today, when was their last activity;
 *   - block (LOCKED: temporary, reversible) / unblock / remove (DISABLED:
 *     permanent but SOFT — account + audit history are kept, never deleted);
 *   - admin-assigned tasks: attach a concrete instruction to one specific
 *     worker ("receive order/arrival X"); it appears in that worker's terminal
 *     and comes back here as DONE with a note when they report it.
 *
 * Every action is server-audited and gated by users.manage; the page is
 * readable with operations.view (the nav gate) but the controls only render
 * for users.manage. Protected SUPER_ADMIN accounts never appear here.
 */
export default function Workers() {
  const { id } = useParams();
  return id ? <WorkerDetail id={id} /> : <WorkerList />;
}

/* ------------------------------------------------------------------ list -- */

function WorkerList() {
  const { data, loading, error, reload } = useAsync(() => adminApi.workers(), []);
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('users.manage');

  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Bump to remount the registry after an assignment so it reflects it live.
  const [regKey, setRegKey] = useState(0);

  const [ask, setAsk] = useState<
    | { kind: 'block'; w: WorkerRow }
    | { kind: 'unblock'; w: WorkerRow }
    | { kind: 'remove'; w: WorkerRow }
    | { kind: 'assign'; w: WorkerRow }
    | { kind: 'add' }
    | null
  >(null);

  const tell = (ok: boolean, text: string) => {
    setFlash({ ok, text });
    window.setTimeout(() => setFlash(null), 6000);
  };

  const act = useCallback(
    async (fn: () => Promise<unknown>, okMsg: string) => {
      setBusyId('__act__');
      try {
        await fn();
        tell(true, okMsg);
        await reload();
      } catch (e) {
        tell(false, apiErrorMessage(e));
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Workers</h1>
          <p className="ac-sub">
            Floor staff, their status, today's presence and assigned tasks.
          </p>
        </div>
        {canManage && (
          <button type="button" className="os-btn" onClick={() => setAsk({ kind: 'add' })}>
            + Add worker
          </button>
        )}
      </header>

      {flash && <div className={flash.ok ? 'ac-ok' : 'ac-error'}>{flash.text}</div>}
      {error && <div className="ac-error">{error}</div>}

      {canManage && (
        <div className="os-card" style={{ margin: '0 0 12px', padding: '10px 14px' }}>
          <span className="os-muted" style={{ fontSize: '0.8rem' }}>
            <strong>BLOCK</strong> locks the account temporarily (login refused, reversible at any
            time). <strong>REMOVE</strong> is permanent separation — the account is disabled and
            kept with its full audit history (never deleted). Both actions are recorded with your
            identity. Only workers (never admins) can be managed here.
          </span>
        </div>
      )}

      <section className="os-card">
        {loading && !data ? (
          <div className="os-empty">loading workers…</div>
        ) : (
          <table className="os-table">
            <thead>
              <tr>
                <th>Name</th><th>Code</th><th>Roles</th><th>Station</th><th>Status</th>
                <th>Worked today</th><th>Sessions</th><th>Open tasks</th><th />
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((w) => (
                <WorkerRowLine
                  key={w.id}
                  w={w}
                  canManage={canManage}
                  busy={busyId === w.id}
                  onAsk={setAsk}
                  onInspect={() => navigate(`/admin/workers/${w.id}`)}
                />
              ))}
              {data?.length === 0 && (
                <tr><td colSpan={9} className="os-empty">No workers found.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      {canManage && <TaskRegistry key={regKey} />}

      {ask?.kind === 'block' && (
        <ReasonModal
          title={`Block ${ask.w.name}`}
          body={`${ask.w.employeeCode} will be LOCKED: the account stays intact and can be unblocked later, but the worker can no longer sign in. Open sessions end.`}
          confirmLabel="Block worker"
          optionalReason
          onSubmit={(reason) =>
            act(() => adminApi.blockWorker(ask.w.id, reason || undefined), `${ask.w.employeeCode} blocked.`)
              .then(() => setAsk(null))
          }
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.kind === 'unblock' && (
        <ConfirmModal
          title={`Unblock ${ask.w.name}`}
          body={`${ask.w.employeeCode} will be set back to ACTIVE and can sign in again.`}
          confirmLabel="Unblock worker"
          onSubmit={() =>
            act(() => adminApi.unblockWorker(ask.w.id), `${ask.w.employeeCode} unblocked.`)
              .then(() => setAsk(null))
          }
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.kind === 'remove' && (
        <ReasonModal
          title={`Remove ${ask.w.name} permanently`}
          body={`${ask.w.employeeCode} will be DISABLED for good. This is a final separation: the account and all of its history stay in the system for audit, but the worker will never sign in again. Open assigned tasks are cancelled. This cannot be undone in the UI.`}
          confirmLabel="Remove worker permanently"
          danger
          reasonMin={8}
          reasonPlaceholder="written reason, e.g. left the company on notice, misconduct"
          onSubmit={(reason) =>
            act(() => adminApi.removeWorker(ask.w.id, reason), `${ask.w.employeeCode} removed (soft).`)
              .then(() => setAsk(null))
          }
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.kind === 'assign' && (
        <AssignTaskModal
          w={ask.w}
          onDone={(msg) => {
            tell(true, msg);
            setAsk(null);
            setRegKey((k) => k + 1); // refresh the registry so it shows the new task
            void reload();
          }}
          onClose={() => setAsk(null)}
        />
      )}

      {ask?.kind === 'add' && (
        <AddWorkerModal
          onDone={(msg) => {
            tell(true, msg);
            setAsk(null);
            void reload();
          }}
          onClose={() => setAsk(null)}
        />
      )}
    </>
  );
}

function statusTag(s: string) {
  const map: Record<string, { cls: string; label: string }> = {
    ACTIVE: { cls: 'os-tag--ok', label: 'ACTIVE' },
    LOCKED: { cls: 'os-tag--warn', label: 'BLOCKED' },
    DISABLED: { cls: 'os-tag--err', label: 'REMOVED' },
  };
  const m = map[s] ?? { cls: 'os-tag--muted', label: s };
  return <span className={`os-tag ${m.cls}`}>{m.label}</span>;
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTimeOf = (iso: string) => new Date(iso).toLocaleString();

function WorkerRowLine({
  w,
  canManage,
  busy,
  onAsk,
  onInspect,
}: {
  w: WorkerRow;
  canManage: boolean;
  busy: boolean;
  onAsk: (q: { kind: 'block' | 'unblock' | 'remove' | 'assign'; w: WorkerRow }) => void;
  onInspect: () => void;
}) {
  const presence = w.workedToday
    ? (w.lastActivityAt
        ? <span className="os-tag os-tag--ok" title={dateTimeOf(w.lastActivityAt)}>YES · {timeOf(w.lastActivityAt)}</span>
        : <span className="os-tag os-tag--ok">YES</span>)
    : (w.lastActivityAt
        ? <span className="os-muted" title={`last activity ${dateTimeOf(w.lastActivityAt)}`}>NO</span>
        : <span className="os-muted">never</span>);

  const controllable = canManage && w.status !== 'DISABLED';

  return (
    <tr style={busy ? { opacity: 0.5 } : undefined}>
      <td>{w.name}</td>
      <td className="mono">{w.employeeCode}</td>
      <td className="os-muted">{w.roles.length ? w.roles.join(', ') : '—'}</td>
      <td>{w.station
        ? <span className="os-tag os-tag--info">{w.station.code}</span>
        : <span className="os-muted">unassigned</span>}</td>
      <td>{statusTag(w.status)}</td>
      <td>{presence}</td>
      <td className="os-muted">{w.sessionsToday}</td>
      <td>{w.pendingTasks
        ? <span className="os-tag os-tag--warn">{w.pendingTasks}</span>
        : <span className="os-muted">0</span>}</td>
      <td>
        <div className="ac-rowbtns">
          <button type="button" className="ac-linkbtn" onClick={onInspect}>inspect</button>
          {controllable && w.status === 'ACTIVE' && (
            <button type="button" className="ac-linkbtn" onClick={() => onAsk({ kind: 'assign', w })}>
              + task
            </button>
          )}
          {controllable && w.status === 'ACTIVE' && (
            <button type="button" className="ac-linkbtn" onClick={() => onAsk({ kind: 'block', w })}>
              block
            </button>
          )}
          {controllable && w.status === 'LOCKED' && (
            <button type="button" className="ac-linkbtn" onClick={() => onAsk({ kind: 'unblock', w })}>
              unblock
            </button>
          )}
          {controllable && (
            <button type="button" className="ac-linkbtn ac-linkbtn--danger" onClick={() => onAsk({ kind: 'remove', w })}>
              remove
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------- assigned registry -- */

function TaskRegistry() {
  const [filter, setFilter] = useState('OPEN');
  const { data, loading, error, reload } = useAsync(
    () => adminApi.workerTasks(filter === 'ALL' ? {} : { status: filter }),
    [filter],
  );
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const cancel = async (t: WorkerTaskRow) => {
    setCancelId(t.id);
    try {
      await adminApi.workerTaskCancel(t.id, 'cancelled by admin');
      setFlash({ ok: true, text: `Task "${t.title}" cancelled.` });
      window.setTimeout(() => setFlash(null), 5000);
      await reload();
    } catch (e) {
      setFlash({ ok: false, text: apiErrorMessage(e) });
      window.setTimeout(() => setFlash(null), 7000);
    } finally {
      setCancelId(null);
    }
  };

  return (
    <section className="os-card" style={{ marginTop: 14 }}>
      <div className="os-spread" style={{ marginBottom: 8 }}>
        <h2 className="os-card-title">Assigned task registry</h2>
        <select className="os-input os-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {['OPEN', 'ALL', 'DONE', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {flash && <div className={flash.ok ? 'ac-ok' : 'ac-error'}>{flash.text}</div>}
      {error && <div className="ac-error">{error}</div>}
      {loading && !data ? (
        <div className="os-empty">loading…</div>
      ) : (
        <table className="os-table">
          <thead>
            <tr><th>Worker</th><th>Task</th><th>Reference</th><th>Status</th><th>Created by</th><th>Result / note</th><th /></tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.id}>
                <td>
                  {t.worker ? (
                    <>
                      {t.worker.name} <span className="os-muted mono">· {t.worker.employeeCode}</span>
                    </>
                  ) : <span className="os-muted">—</span>}
                </td>
                <td>
                  <div style={{ fontWeight: 600 }}>{t.title}</div>
                  {t.description && <div className="os-muted" style={{ fontSize: '0.8rem' }}>{t.description}</div>}
                </td>
                <td className="os-muted">
                  {t.relatedType && t.relatedCode
                    ? <span className="mono">{t.relatedType.toUpperCase()} · {t.relatedCode}</span>
                    : '—'}
                </td>
                <td>
                  <span className={`os-tag ${t.status === 'OPEN' ? 'os-tag--warn' : t.status === 'DONE' ? 'os-tag--ok' : 'os-tag--muted'}`}>
                    {t.status}
                  </span>
                </td>
                <td className="os-muted">
                  {t.createdBy ? `${t.createdBy.name} (${t.createdBy.employeeCode})` : '—'}
                  <div style={{ fontSize: '0.75rem' }}>{new Date(t.createdAt).toLocaleString()}</div>
                </td>
                <td className="os-muted" style={{ fontSize: '0.82rem' }}>
                  {t.status === 'DONE' && t.completedBy
                    ? <>Done by {t.completedBy.employeeCode}{t.note ? `: ${t.note}` : ''}</>
                    : t.status === 'CANCELLED'
                      ? (t.worker?.status === 'DISABLED' ? 'worker removed' : 'cancelled by admin')
                      : '—'}
                </td>
                <td>
                  {t.status === 'OPEN' && (
                    <button type="button" className="ac-linkbtn ac-linkbtn--danger" disabled={cancelId === t.id} onClick={() => void cancel(t)}>
                      cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr><td colSpan={7} className="os-empty">No assigned tasks{filter !== 'ALL' ? ` with status ${filter}` : ''}.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- add worker -- */

function AddWorkerModal({ onDone, onClose }: { onDone: (m: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('INBOUND_WORKER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length >= 2 && code.trim().length >= 3 && password.length >= 6;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      await adminApi.createWorker({ name: name.trim(), employeeCode: code.trim(), password, roles: [role] });
      onDone(`Worker ${code.trim()} created (ACTIVE). Assign a station from the Stations screen when ready.`);
    } catch (e) { setError(apiErrorMessage(e)); setBusy(false); }
  }

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <div className="ac-modal-box">
        <h2 className="ac-modal-title">Add a new worker</h2>
        <p className="ac-sub">Creates an ACTIVE account that can sign in at the terminal with this role. Audit entry is recorded.</p>

        <div>
          <label className="os-label" htmlFor="aw-name">Full name</label>
          <input id="aw-name" className="os-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amin Ben Salah" autoFocus />
        </div>
        <div>
          <label className="os-label" htmlFor="aw-code">Employee code / login</label>
          <input id="aw-code" className="os-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. WORKER009" />
        </div>
        <div>
          <label className="os-label" htmlFor="aw-pass">Password (terminal sign-in)</label>
          <input id="aw-pass" className="os-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 6 characters" />
        </div>
        <div>
          <label className="os-label" htmlFor="aw-role">Worker role</label>
          <select id="aw-role" className="os-input os-select" value={role} onChange={(e) => setRole(e.target.value)}>
            {WORKER_ROLE_OPTIONS.map((r) => <option key={r.name} value={r.name}>{r.label} ({r.name})</option>)}
          </select>
        </div>

        {error && <div className="ac-error">{error}</div>}

        <div className="ac-modal-actions">
          <button type="button" className="os-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="os-btn os-btn--primary" onClick={submit} disabled={!valid || busy}>
            {busy ? 'Creating…' : 'Create worker'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- assign a task -- */

const REF_TYPES = [
  { v: '', label: 'no reference' },
  { v: 'ARRIVAL', label: 'Arrival' },
  { v: 'ORDER', label: 'Order' },
  { v: 'CONTAINER', label: 'Container' },
];

function AssignTaskModal({ w, onDone, onClose }: { w: WorkerRow; onDone: (m: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [refType, setRefType] = useState('');
  const [refCode, setRefCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = title.trim().length >= 3;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      await adminApi.workerTaskCreate({
        workerId: w.id,
        title: title.trim(),
        description: description.trim() ? description.trim() : undefined,
        relatedType: refType || undefined,
        relatedCode: refType && refCode.trim() ? refCode.trim() : undefined,
      });
      onDone(`Task assigned to ${w.employeeCode} — it now appears in their terminal.`);
    } catch (e) { setError(apiErrorMessage(e)); setBusy(false); }
  }

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <div className="ac-modal-box">
        <h2 className="ac-modal-title">Assign task to {w.name}</h2>
        <p className="ac-sub">{w.employeeCode} · {w.roles.join(', ')} — the task will appear at the top of the worker terminal and can be marked DONE there.</p>

        <div>
          <label className="os-label" htmlFor="at-title">Task title</label>
          <input id="at-title" className="os-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Receive arrival X and verify contents" autoFocus />
        </div>
        <div>
          <label className="os-label" htmlFor="at-desc">Details / instructions (optional)</label>
          <textarea id="at-desc" className="os-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. call the supervisor before closing the gate" />
        </div>
        <div className="os-grid2">
          <div>
            <label className="os-label" htmlFor="at-ref">Reference type (optional)</label>
            <select id="at-ref" className="os-input os-select" value={refType} onChange={(e) => setRefType(e.target.value)}>
              {REF_TYPES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="os-label" htmlFor="at-code">Reference code</label>
            <input id="at-code" className="os-input" value={refCode} onChange={(e) => setRefCode(e.target.value)} placeholder="e.g. ARR-2026-0001" disabled={!refType} />
          </div>
        </div>

        {error && <div className="ac-error">{error}</div>}

        <div className="ac-modal-actions">
          <button type="button" className="os-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="os-btn os-btn--primary" onClick={submit} disabled={!valid || busy}>
            {busy ? 'Assigning…' : 'Assign task'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- shared modals -- */

function ReasonModal({
  title, body, confirmLabel, danger, optionalReason, reasonMin = 8, reasonPlaceholder,
  onSubmit, onClose,
}: {
  title: string; body: string; confirmLabel: string; danger?: boolean;
  optionalReason?: boolean; reasonMin?: number; reasonPlaceholder?: string;
  onSubmit: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = !optionalReason && reason.trim().length < reasonMin;

  async function submit() {
    if (tooShort || busy) return;
    setBusy(true); setError(null);
    try { await onSubmit(reason.trim()); } catch (e) { setError(apiErrorMessage(e)); setBusy(false); }
  }

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <div className="ac-modal-box">
        <h2 className="ac-modal-title">{title}</h2>
        <p className="ac-sub">{body}</p>
        <div className="ac-modal-warn">
          The action is recorded in the audit log with your identity and a timestamp.
        </div>
        <div>
          <label className="os-label" htmlFor="rm-reason">
            {optionalReason ? 'Reason (optional)' : `Reason (required, at least ${reasonMin} characters)`}
          </label>
          <textarea
            id="rm-reason"
            className="os-input"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder ?? 'written reason for the record'}
          />
        </div>
        {error && <div className="ac-error">{error}</div>}
        <div className="ac-modal-actions">
          <button type="button" className="os-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={`os-btn ${danger ? 'os-btn--danger' : 'os-btn--primary'}`}
            onClick={submit}
            disabled={tooShort || busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title, body, confirmLabel, onSubmit, onClose,
}: {
  title: string; body: string; confirmLabel: string;
  onSubmit: () => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSubmit(); } catch (e) { setError(apiErrorMessage(e)); setBusy(false); }
  }

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <div className="ac-modal-box">
        <h2 className="ac-modal-title">{title}</h2>
        <p className="ac-sub">{body}</p>
        {error && <div className="ac-error">{error}</div>}
        <div className="ac-modal-actions">
          <button type="button" className="os-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="os-btn os-btn--primary" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail -- */

function WorkerDetail({ id }: { id: string }) {
  const { data, loading, error } = useAsync(() => adminApi.worker(id), [id]);
  const navigate = useNavigate();

  if (loading && !data) return <div className="os-empty">loading worker…</div>;
  if (error) return <div className="ac-error">{error}</div>;
  if (!data) return null;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">{data.worker.name}</h1>
          <p className="ac-sub">
            {data.worker.employeeCode} · {data.worker.roles.join(', ')} ·{' '}
            {data.worker.station ? `Station ${data.worker.station.code}` : 'no station'}
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => navigate('/admin/workers')}>Back</button>
      </header>

      <section className="os-card">
        <h2 className="os-card-title">Sessions</h2>
        <table className="os-table">
          <thead>
            <tr><th>Session</th><th>Arrival</th><th>Started</th><th>Status</th><th>Cartons</th><th>Exc.</th><th /></tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.code}</td>
                <td>{s.arrival?.code ?? '—'}</td>
                <td className="os-muted">{new Date(s.startedAt).toLocaleString()}</td>
                <td><span className="os-tag os-tag--info">{s.status}</span></td>
                <td>{s.counts.cartons}</td>
                <td>{s.counts.discrepancies > 0
                  ? <span className="os-tag os-tag--err">{s.counts.discrepancies}</span>
                  : <span className="os-muted">0</span>}</td>
                <td>
                  <button className="ac-linkbtn" onClick={() => navigate(`/admin/sessions/${s.id}`)}>
                    operations
                  </button>
                </td>
              </tr>
            ))}
            {data.sessions.length === 0 && <tr><td colSpan={7} className="os-empty">No sessions yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="os-card" style={{ marginTop: 14 }}>
        <h2 className="os-card-title">Putaway sessions</h2>
        <table className="os-table">
          <thead>
            <tr><th>Session</th><th>Station</th><th>Started</th><th>Status</th><th>Placements</th></tr>
          </thead>
          <tbody>
            {data.putawaySessions.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.code}</td>
                <td className="os-muted">{p.stationCode ?? '—'}</td>
                <td className="os-muted">{new Date(p.startedAt).toLocaleString()}</td>
                <td>
                  <span className={`os-tag ${p.status === 'COMPLETED' ? 'os-tag--ok' : 'os-tag--info'}`}>
                    {p.status}
                  </span>
                </td>
                <td>{p.placements}</td>
              </tr>
            ))}
            {data.putawaySessions.length === 0 && (
              <tr><td colSpan={5} className="os-empty">No stowing yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
