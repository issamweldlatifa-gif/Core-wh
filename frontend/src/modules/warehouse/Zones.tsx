import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, Zone } from './api';
import { statusTag, StatusActions } from './components';

export default function Zones() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('zones.create');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [form, setForm] = useState({ code: '', name: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => { api.warehouses().then((w) => { setWarehouses(w); if (w[0] && !whId) setWhId(w[0].id); }); }, []);
  useEffect(() => {
    if (!whId) { setZones([]); return; }
    api.zones(whId).then(setZones).catch((e) => setErr(apiErrorMessage(e)));
  }, [whId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !whId) return;
    setSaving(true); setErr(null); setMsg(null);
    try { await api.createZone({ warehouseId: whId, ...form }); setMsg('Zone created.'); setForm({ code: '', name: '' }); api.zones(whId).then(setZones); }
    catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }
  async function toggle(z: Zone, s: 'ACTIVE' | 'INACTIVE') {
    setBusyId(z.id);
    try { await api.zoneStatus(z.id, s); if (whId) api.zones(whId).then(setZones); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Zones</h1>
      <p className="page-sub">Zones within a warehouse. Zone codes are unique per warehouse, but may repeat across warehouses.</p>
      <div className="card">
        <label>Warehouse</label>
        <select value={whId} onChange={(e) => setWhId(e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
      </div>

      {canCreate && (
        <div className="card">
          <h3>Create zone</h3>
          {msg && <div className="ok-box">{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="SHOES" required /></div>
            <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Shoes" required /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Zones in this warehouse</h3>
        {zones.length === 0 && <p className="empty">No zones yet.</p>}
        {zones.length > 0 && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.id}>
                  <td><strong>{z.code}</strong></td>
                  <td>{z.name}</td>
                  <td>{statusTag(z.status)}</td>
                  <td><StatusActions status={z.status} perm="zones" onActivate={() => toggle(z, 'ACTIVE')} onDeactivate={() => toggle(z, 'INACTIVE')} busy={busyId === z.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
