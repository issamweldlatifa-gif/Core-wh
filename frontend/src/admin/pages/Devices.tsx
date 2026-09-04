import { useState } from 'react';
import { adminApi } from '../api';
import { useAsync } from './useAsync';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';

/**
 * DEVICE REGISTRY — hardware allowed to open a WORKER_NATIVE session.
 *
 * Strict isolation (Order #3): the Worker App never trusts the client. A
 * device must be registered HERE (Admin Web is the source of truth), ACTIVE,
 * and — from the first successful sign-in — bound to the worker who uses it.
 * Without this page the loop is broken: the app correctly refuses
 * "This device is not authorized" but the admin has no place to authorize it.
 *
 * Reads gated by stations.view, writes by stations.manage (mirrors the
 * devices controller semantics: the registry is workforce vocabulary).
 */
export default function Devices() {
  const devices = useAsync(() => adminApi.devices(), []);
  const workers = useAsync(() => adminApi.workers().catch(() => []), []);
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stations.manage');

  const [form, setForm] = useState({ code: '', name: '', model: '', stationCode: '', workerId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await adminApi.createDevice({
        code: form.code,
        name: form.name,
        model: form.model || undefined,
        stationCode: form.stationCode || undefined,
        workerId: form.workerId || undefined,
      });
      setForm({ code: '', name: '', model: '', stationCode: '', workerId: '' });
      await devices.reload();
    } catch (ex) { setErr(apiErrorMessage(ex)); } finally { setBusy(false); }
  }

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await devices.reload(); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
  }

  const fmt = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Devices</h1>
        <p className="ac-sub">
          Hardware allowed to sign in to the Worker app. The code shown on the app’s
          login screen must be registered here first — the backend refuses any
          unregistered device.
        </p>
      </header>

      {(err || devices.error) && <div className="ac-error">{err ?? devices.error}</div>}

      <section className="os-card" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent-2, #58a6ff)' }}>
        <h2 className="os-card-title">How to onboard a phone / CT40</h2>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem', lineHeight: 1.7, color: 'var(--text-dim, #9aa7bd)' }}>
          <li>Open the Worker app on the device — the login screen shows its <strong>Device code</strong> (e.g. <span className="mono">AYROVI-3F9K2A</span>).</li>
          <li>Register that code below (ACTIVE by default).</li>
          <li>The worker signs in once → the device is <strong>bound automatically</strong> to that worker (re-assignable here any time).</li>
          <li>Disabling a device immediately revokes its live sessions.</li>
        </ol>
      </section>

      {canManage && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <h2 className="os-card-title">Register a device</h2>
          <form onSubmit={create} className="os-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', alignItems: 'end' }}>
            <div>
              <label className="os-label" htmlFor="dev-code">Code (shown by the app)</label>
              <input id="dev-code" className="os-input" value={form.code} required
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="AYROVI-3F9K2A" pattern="[A-Z0-9][A-Z0-9_-]{1,29}" title="2-30 chars: A-Z, 0-9, _ or -" />
            </div>
            <div>
              <label className="os-label" htmlFor="dev-name">Name</label>
              <input id="dev-name" className="os-input" value={form.name} required
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="CT40 Receiving dock 1" />
            </div>
            <div>
              <label className="os-label" htmlFor="dev-model">Model (optional)</label>
              <input id="dev-model" className="os-input" value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="Honeywell CT40 / Galaxy A15" />
            </div>
            <div>
              <label className="os-label" htmlFor="dev-station">Station code (optional)</label>
              <input id="dev-station" className="os-input" value={form.stationCode}
                onChange={(e) => setForm({ ...form, stationCode: e.target.value.toUpperCase() })}
                placeholder="ST-REC-01" />
            </div>
            <div>
              <label className="os-label" htmlFor="dev-worker">Bind to worker (optional)</label>
              <select id="dev-worker" className="os-input" value={form.workerId}
                onChange={(e) => setForm({ ...form, workerId: e.target.value })}>
                <option value="">— later (auto-bind on first sign-in) —</option>
                {(workers.data ?? []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name} ({w.employeeCode})</option>
                ))}
              </select>
            </div>
            <div><button className="os-btn os-btn--primary" type="submit" disabled={busy}>Register</button></div>
          </form>
        </section>
      )}

      <section className="os-card">
        {devices.loading && !devices.data ? <div className="os-empty">loading…</div> : (
          <table className="os-table">
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Model</th><th>Status</th>
                <th>Worker</th><th>Last seen</th><th />
              </tr>
            </thead>
            <tbody>
              {(devices.data ?? []).map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.code}</td>
                  <td>{d.name}</td>
                  <td className="os-muted">{d.model ?? '—'}</td>
                  <td>
                    <span className={`os-tag ${d.status === 'ACTIVE' ? 'os-tag--ok' : 'os-tag--muted'}`}>{d.status}</span>
                  </td>
                  <td>
                    {canManage ? (
                      <select
                        className="os-input"
                        value={d.assignedWorker?.id ?? ''}
                        onChange={(e) => act(() => adminApi.assignDevice(d.id, e.target.value || null))}
                      >
                        <option value="">— unassigned —</option>
                        {(workers.data ?? []).map((w) => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                    ) : (d.assignedWorker?.name ?? <span className="os-muted">unassigned</span>)}
                  </td>
                  <td className="os-muted">{fmt(d.lastSeenAt)}</td>
                  <td>
                    {canManage && (
                      <button className="ac-linkbtn"
                        onClick={() => act(() => adminApi.deviceStatus(d.id, d.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'))}>
                        {d.status === 'ACTIVE' ? 'disable' : 'activate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {devices.data?.length === 0 && <tr><td colSpan={7} className="os-empty">No devices registered yet.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
