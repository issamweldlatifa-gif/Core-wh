import { useState } from 'react';
import { adminApi } from '../api';
import { useAsync } from './useAsync';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';

const DEPARTMENTS = ['RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH'];
const CAPS = ['CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'PRINTER', 'SCALE'];

/** Station registry + worker assignment (§10). */
export default function Stations() {
  const stations = useAsync(() => adminApi.stations(), []);
  const workers = useAsync(() => adminApi.workers().catch(() => []), []);
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stations.manage');

  const [form, setForm] = useState({ code: '', name: '', department: 'RECEIVING', capabilities: ['CAMERA'] as string[] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await adminApi.createStation(form);
      setForm({ code: '', name: '', department: 'RECEIVING', capabilities: ['CAMERA'] });
      await stations.reload();
    } catch (ex) { setErr(apiErrorMessage(ex)); } finally { setBusy(false); }
  }

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await stations.reload(); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
  }

  const toggleCap = (c: string) =>
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(c)
        ? f.capabilities.filter((x) => x !== c)
        : [...f.capabilities, c],
    }));

  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Stations</h1>
        <p className="ac-sub">Physical work positions, their hardware capabilities and assigned worker.</p>
      </header>

      {(err || stations.error) && <div className="ac-error">{err ?? stations.error}</div>}

      {canManage && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <h2 className="os-card-title">Create station</h2>
          <form onSubmit={create} className="os-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', alignItems: 'end' }}>
            <div>
              <label className="os-label" htmlFor="st-code">Code</label>
              <input id="st-code" className="os-input" value={form.code} required
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="ST-REC-03" />
            </div>
            <div>
              <label className="os-label" htmlFor="st-name">Name</label>
              <input id="st-name" className="os-input" value={form.name} required
                onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Receiving Dock 3" />
            </div>
            <div>
              <label className="os-label" htmlFor="st-dept">Department</label>
              <select id="st-dept" className="os-input" value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <span className="os-label">Capabilities</span>
              <div className="os-row" style={{ flexWrap: 'wrap' }}>
                {CAPS.map((c) => (
                  <label key={c} className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
                    <input type="checkbox" checked={form.capabilities.includes(c)} onChange={() => toggleCap(c)} />
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <div><button className="os-btn os-btn--primary" type="submit" disabled={busy}>Create</button></div>
          </form>
        </section>
      )}

      <section className="os-card">
        {stations.loading && !stations.data ? <div className="os-empty">loading…</div> : (
          <table className="os-table">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Department</th><th>Capabilities</th><th>Worker</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {(stations.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td>
                  <td>{s.name}</td>
                  <td className="os-muted">{s.department}</td>
                  <td className="os-muted" style={{ fontSize: '0.72rem' }}>{s.capabilities.join(' · ') || '—'}</td>
                  <td>
                    {canManage ? (
                      <select
                        className="os-input"
                        value={s.assignedWorker?.id ?? ''}
                        onChange={(e) => act(() => adminApi.assignStation(s.id, e.target.value || null))}
                      >
                        <option value="">— unassigned —</option>
                        {(workers.data ?? []).map((w) => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                    ) : (s.assignedWorker?.name ?? <span className="os-muted">unassigned</span>)}
                  </td>
                  <td>
                    <span className={`os-tag ${s.status === 'ACTIVE' ? 'os-tag--ok' : 'os-tag--muted'}`}>{s.status}</span>
                  </td>
                  <td>
                    {canManage && (
                      <button className="ac-linkbtn"
                        onClick={() => act(() => adminApi.stationStatus(s.id, s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'))}>
                        {s.status === 'ACTIVE' ? 'deactivate' : 'activate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {stations.data?.length === 0 && <tr><td colSpan={7} className="os-empty">No stations yet.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
