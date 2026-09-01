import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, Zone, Aisle, Rack, Level } from './api';
import { statusTag, StatusActions } from './components';

export default function Levels() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('levels.create');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [aisles, setAisles] = useState<Aisle[]>([]);
  const [aisleId, setAisleId] = useState('');
  const [racks, setRacks] = useState<Rack[]>([]);
  const [rackId, setRackId] = useState('');
  const [levels, setLevels] = useState<Level[]>([]);
  const [levelNumber, setLevelNumber] = useState(1);
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
    if (!zoneId) { setAisles([]); setAisleId(''); return; }
    api.aisles(zoneId).then((a) => { setAisles(a); setAisleId(a[0]?.id ?? ''); });
  }, [zoneId]);
  useEffect(() => {
    if (!aisleId) { setRacks([]); setRackId(''); return; }
    api.racks(aisleId).then((r) => { setRacks(r); setRackId(r[0]?.id ?? ''); });
  }, [aisleId]);
  useEffect(() => {
    if (!rackId) { setLevels([]); return; }
    api.levels(rackId).then(setLevels);
  }, [rackId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !rackId) return;
    setSaving(true); setErr(null); setMsg(null);
    try { await api.createLevel({ rackId, levelNumber }); setMsg(`Level L${String(levelNumber).padStart(2, '0')} created.`); setLevelNumber(levelNumber + 1); api.levels(rackId).then(setLevels); }
    catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }
  async function toggle(l: Level, s: 'ACTIVE' | 'INACTIVE') {
    setBusyId(l.id);
    try { await api.levelStatus(l.id, s); api.levels(rackId).then(setLevels); } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Levels</h1>
      <p className="page-sub">Levels within a rack. Display code (L##) is auto-derived from the numeric order.</p>
      <div className="card">
        <label>Warehouse</label>
        <select value={whId} onChange={(e) => setWhId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select>
        <label>Zone</label>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{zones.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}</select>
        <label>Aisle</label>
        <select value={aisleId} onChange={(e) => setAisleId(e.target.value)}>{aisles.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select>
        <label>Rack</label>
        <select value={rackId} onChange={(e) => setRackId(e.target.value)}>{racks.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}</select>
      </div>

      {canCreate && (
        <div className="card">
          <h3>Create level</h3>
          {msg && <div className="error-box" style={{ borderColor: 'var(--success)', color: '#47d08c' }}>{msg}</div>}
          {err && <div className="error-box">{err}</div>}
          <form onSubmit={save} className="grid2">
            <div><label>Level number (order)</label><input type="number" min={1} value={levelNumber} onChange={(e) => setLevelNumber(Number(e.target.value))} required /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Levels in this rack</h3>
        {levels.length === 0 && <p className="empty">No levels yet.</p>}
        {levels.length > 0 && (
          <table>
            <thead><tr><th>Code</th><th>Order</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.code}</strong></td><td>{l.levelNumber}</td><td>{statusTag(l.status)}</td>
                  <td><StatusActions status={l.status} perm="levels" onActivate={() => toggle(l, 'ACTIVE')} onDeactivate={() => toggle(l, 'INACTIVE')} busy={busyId === l.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
