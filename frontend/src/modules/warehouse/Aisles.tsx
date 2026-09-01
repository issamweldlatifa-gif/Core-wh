import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, Zone, Aisle } from './api';
import { statusTag, StatusActions } from './components';

export default function Aisles() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('aisles.create');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [aisles, setAisles] = useState<Aisle[]>([]);
  const [form, setForm] = useState({ code: '', name: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => { api.warehouses().then((w) => { setWarehouses(w); if (w[0]) setWhId(w[0].id); }); }, []);
  useEffect(() => {
    if (!whId) { setZones([]); setZoneId(''); return; }
    api.zones(whId).then((z) => { setZones(z); setZoneId(z[0]?.id ?? ''); });
  }, [whId]);
  useEffect(() => {
    if (!zoneId) { setAisles([]); return; }
    api.aisles(zoneId).then(setAisles);
  }, [zoneId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !zoneId) return;
    setSaving(true); setErr(null); setMsg(null);
    try { await api.createAisle({ zoneId, ...form }); setMsg('Aisle created.'); setForm({ code: '', name: '' }); api.aisles(zoneId).then(setAisles); }
    catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }
  async function toggle(a: Aisle, s: 'ACTIVE' | 'INACTIVE') {
    setBusyId(a.id);
    try { await api.aisleStatus(a.id, s); api.aisles(zoneId).then(setAisles); } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Aisles</h1>
      <p className="page-sub">Aisles within a zone. Aisle codes are unique per zone.</p>
      <div className="card">
        <label>Warehouse</label>
        <select value={whId} onChange={(e) => setWhId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
        <label>Zone</label>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{zones.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}</select>
      </div>

      {canCreate && (
        <div className="card">
          <h3>Create aisle</h3>
          {msg && <div className="ok-box">{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="A01" required /></div>
            <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Aisle 1" required /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Aisles in this zone</h3>
        {aisles.length === 0 && <p className="empty">No aisles yet.</p>}
        {aisles.length > 0 && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {aisles.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.code}</strong></td><td>{a.name}</td><td>{statusTag(a.status)}</td>
                  <td><StatusActions status={a.status} perm="aisles" onActivate={() => toggle(a, 'ACTIVE')} onDeactivate={() => toggle(a, 'INACTIVE')} busy={busyId === a.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
