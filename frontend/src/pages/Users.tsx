import { useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import { useAuth } from '../context/AuthContext';
import client, { apiErrorMessage } from '../api/client';

interface RoleRef { id: string; name: string }
interface UserRow {
  id: string; name: string; employeeCode: string; email: string | null; status: string; roles: RoleRef[];
}

export default function Users() {
  const { hasPermission } = useAuth();
  const { data: users, loading, error, reload } = useFetch<UserRow[]>('/v1/users');
  const { data: roles } = useFetch<any[]>('/v1/roles');
  const canManage = hasPermission('users.manage');

  const [form, setForm] = useState({ name: '', employeeCode: '', email: '', password: '', roles: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      const roleNames = form.roles ? form.roles.split(',').map((r) => r.trim()).filter(Boolean) : [];
      await client.post('/v1/users', {
        name: form.name,
        employeeCode: form.employeeCode,
        email: form.email || undefined,
        password: form.password,
        roles: roleNames,
      });
      setMsg('User created.');
      setForm({ name: '', employeeCode: '', email: '', password: '', roles: '' });
      reload();
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Users</h1>
      <p className="page-sub">Staff accounts. An employee code identifies a user; it is never a permission.</p>

      {canManage && (
        <div className="card">
          <h3>Create user</h3>
          {msg && <div className="error-box" style={{ borderColor: 'var(--success)', color: '#47d08c' }}>{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div>
              <label>Full name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label>Employee code</label>
              <input value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} required />
            </div>
            <div>
              <label>Email (optional)</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label>Initial password</label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label>Roles (comma-separated, e.g. PICKER, VIEWER)</label>
              <input value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} placeholder={roles?.length ? roles.map((r) => r.name).join(', ') : 'PICKER, VIEWER'} />
            </div>
            <div>
              <button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Users</h3>
        {loading && <p className="empty">Loading…</p>}
        {error && <div className="error-box">{error}</div>}
        {!loading && (users ?? []).length === 0 && <p className="empty">No users.</p>}
        {!loading && (users ?? []).length > 0 && (
          <table>
            <thead>
              <tr><th>Name</th><th>Code</th><th>Email</th><th>Roles</th><th>Status</th></tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name}</strong></td>
                  <td>{u.employeeCode}</td>
                  <td>{u.email ?? '—'}</td>
                  <td>{u.roles.map((r) => <span key={r.id} className="tag accent" style={{ margin: 2 }}>{r.name}</span>)}</td>
                  <td><span className={`tag ${u.status === 'ACTIVE' ? 'green' : 'red'}`}>{u.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
