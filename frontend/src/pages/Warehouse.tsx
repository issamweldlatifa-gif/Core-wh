import { useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import { useAuth } from '../context/AuthContext';
import client, { apiErrorMessage } from '../api/client';

interface Warehouse {
  id: string; code: string; name: string; address: string | null; status: string;
}

export default function Warehouse() {
  const { hasPermission } = useAuth();
  const { data, loading, error, reload } = useFetch<Warehouse[]>('/v1/warehouse');
  const canManage = hasPermission('warehouse.manage');
  const [form, setForm] = useState({ code: '', name: '', address: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      await client.post('/v1/warehouse', form);
      setMsg('Warehouse saved.');
      setForm({ code: '', name: '', address: '' });
      reload();
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Warehouse</h1>
      <p className="page-sub">Core warehouse foundation (identification/config only — no workflows in Phase 0).</p>

      {canManage && (
        <div className="card">
          <h3>Register / update a warehouse</h3>
          {msg && <div className="error-box" style={{ borderColor: 'var(--success)', color: '#47d08c' }}>{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div>
              <label>Code</label>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="MAIN" required />
            </div>
            <div>
              <label>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main Warehouse" required />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Street, City" />
            </div>
            <div>
              <button className="btn" type="submit" disabled={saving}>
                {saving ? <span className="spinner" /> : null} Save
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Registered warehouses</h3>
        {loading && <p className="empty">Loading…</p>}
        {error && <div className="error-box">{error}</div>}
        {!loading && !error && (data ?? []).length === 0 && <p className="empty">No warehouses yet.</p>}
        {!loading && (data ?? []).length > 0 && (
          <table>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Address</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(data ?? []).map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.code}</strong></td>
                  <td>{w.name}</td>
                  <td>{w.address ?? '—'}</td>
                  <td><span className="tag green">{w.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
