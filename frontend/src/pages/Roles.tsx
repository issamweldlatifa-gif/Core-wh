import { useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import { useAuth } from '../context/AuthContext';
import client, { apiErrorMessage } from '../api/client';

interface RoleRow {
  id: string; name: string; description: string | null; isSystem: boolean;
  permissions: { permission: { key: string } }[];
}

export default function Roles() {
  const { hasPermission } = useAuth();
  const { data: roles, loading, error, reload } = useFetch<RoleRow[]>('/v1/roles');
  const canManage = hasPermission('roles.manage');

  const [form, setForm] = useState({ name: '', description: '', permissions: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      const perms = form.permissions ? form.permissions.split(',').map((p) => p.trim()).filter(Boolean) : [];
      await client.post('/v1/roles', { name: form.name, description: form.description, permissions: perms });
      setMsg('Role created.');
      setForm({ name: '', description: '', permissions: '' });
      reload();
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Roles & Permissions</h1>
      <p className="page-sub">RBAC: roles are granted granular permissions; new roles can be created and assigned dynamically.</p>

      {canManage && (
        <div className="card">
          <h3>Create role</h3>
          {msg && <div className="ok-box">{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div>
              <label>Role name (UPPER_SNAKE)</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })} required />
            </div>
            <div>
              <label>Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label>Permissions (comma-separated keys, e.g. warehouse.view, inventory.manage)</label>
              <input value={form.permissions} onChange={(e) => setForm({ ...form, permissions: e.target.value })} placeholder="warehouse.view, inventory.manage" />
            </div>
            <div>
              <button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Roles</h3>
        {loading && <p className="empty">Loading…</p>}
        {error && <div className="error-box">{error}</div>}
        {!loading && (roles ?? []).length === 0 && <p className="empty">No roles.</p>}
        {!loading && (roles ?? []).length > 0 && (
          <table>
            <thead>
              <tr><th>Role</th><th>Description</th><th>Permissions</th></tr>
            </thead>
            <tbody>
              {(roles ?? []).map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong> {r.isSystem && <span className="tag yellow">system</span>}</td>
                  <td style={{ maxWidth: 260 }}>{r.description ?? '—'}</td>
                  <td>
                    {r.permissions.map((p) => (
                      <span key={p.permission.key} className="tag" style={{ margin: 2 }}>{p.permission.key}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
