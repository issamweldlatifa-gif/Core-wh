import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, Zone, Aisle, Rack } from './api';
import { statusTag, StatusActions } from './components';

export default function Racks() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('racks.create');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [aisles, setAisles] = useState<Aisle[]>([]);
  const [aisleId, setAisleId] = useState('');
  const [racks, setRacks] = useState<Rack[]>([]);
  const [form, setForm] = useState({ code: '', name: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => { api.warehouses().then((w) => { setWarehouses(w); if (w[0]) setWhId(w[0].id); }); }, []);
  useEffect(() => { if (whId) api.zones(whId).then((z) => { setZones(z); if (z[0]) setZoneId(z[0].id); }); }, [whId]);
  useEffect(() => { if (zoneId) api.aisles(zoneId).then((a) => { setAisles(a); if (a[0]) setAisleId(a[0].id); }); }, [zoneId]);
  useEffect(() => { if (aisleId) api.racks(aisleId).then(setRacks); }, [aisleId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !aisleId) return;
    setSaving(true); setErr(null); setMsg(null);
    try { await api.createRack({ aisleId, ...form }); setMsg('Rack created.'); setForm({ code: '', name: '' }); api.racks(aisleId).then(setRacks); }
    catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }
  async function toggle(r: Rack, s: 'ACTIVE' | 'INACTIVE') {
    setBusyId(r.id);
    try { await api.rackStatus(r.id, s); api.racks(aisleId).then(setRacks); } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Racks</h1>
      <p className="page-sub">Racks within an aisle. Rack codes are unique per aisle.</p>
      <div className="card">
        <label>Warehouse</label>
        <select value={whId} onChange={(e) => setWhId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
        <label>Zone</label>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{zones.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}</select>
        <label>Aisle</label>
        <select value={aisleId} onChange={(e) => setAisleId(e.target.value)}>{aisles.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select>
      </div>

      {canCreate && (
        <div className="card">
          <h3>Create rack</h3>
          {msg && <div className="error-box" style={{ borderColor: 'var(--success)', color: '#47d08c' }}>{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="R01" required /></div>
            <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Rack 1" required /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Racks in this aisle</h3>
        {racks.length === 0 && <p className="empty">No racks yet.</p>}
        {racks.length > 0 && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {racks.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.code}</strong></td><td>{r.name}</td><td>{statusTag(r.status)}</td>
                  <td><StatusActions status={r.status} perm="racks" onActivate={() => toggle(r, 'ACTIVE')} onDeactivate={() => toggle(r, 'INACTIVE')} busy={busyId === r.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
