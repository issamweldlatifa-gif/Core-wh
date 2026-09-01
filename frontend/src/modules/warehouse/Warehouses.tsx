import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse } from './api';
import { statusTag, StatusActions } from './components';

export default function Warehouses() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('warehouses.create');
  const [list, setList] = useState<Warehouse[]>([]);
  const [form, setForm] = useState({ code: '', name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => api.warehouses().then(setList).catch((e) => setErr(apiErrorMessage(e)));
  useEffect(() => { load(); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      await api.createWarehouse(form);
      setMsg('Warehouse created.');
      setForm({ code: '', name: '', description: '' });
      load();
    } catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }

  async function toggle(w: Warehouse, s: 'ACTIVE' | 'INACTIVE') {
    setBusyId(w.id);
    try { await api.warehouseStatus(w.id, s); await load(); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Warehouses</h1>
      <p className="page-sub">Top-level physical warehouses. Deactivate rather than delete.</p>

      {canCreate && (
        <div className="card">
          <h3>Create warehouse</h3>
          {msg && <div className="ok-box">{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="TUN-MAIN" required /></div>
            <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main Warehouse" required /></div>
            <div style={{ gridColumn: '1 / -1' }}><label>Description</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Registered warehouses</h3>
        {err && <div className="error-box">{err}</div>}
        {list.length === 0 && <p className="empty">No warehouses yet.</p>}
        {list.length > 0 && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.code}</strong></td>
                  <td>{w.name}</td>
                  <td>{w.description ?? '—'}</td>
                  <td>{statusTag(w.status)}</td>
                  <td><StatusActions status={w.status} perm="warehouses" onActivate={() => toggle(w, 'ACTIVE')} onDeactivate={() => toggle(w, 'INACTIVE')} busy={busyId === w.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
