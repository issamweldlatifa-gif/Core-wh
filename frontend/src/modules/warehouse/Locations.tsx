import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { api, Warehouse, Zone, Aisle, Rack, Level, Location, LocationPaged, LocationType } from './api';
import { statusTag, StatusActions } from './components';

const TYPES: LocationType[] = ['STORAGE', 'RECEIVING', 'SORTING', 'PACKING', 'RETURNS', 'QC', 'STAGING'];

export default function Locations() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('locations.create');

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [zoneId, setZoneId] = useState('');
  const [aisles, setAisles] = useState<Aisle[]>([]);
  const [aisleId, setAisleId] = useState('');
  const [racks, setRacks] = useState<Rack[]>([]);
  const [rackId, setRackId] = useState('');
  const [levels, setLevels] = useState<Level[]>([]);
  const [levelId, setLevelId] = useState('');

  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [data, setData] = useState<LocationPaged | null>(null);

  const [locType, setLocType] = useState<LocationType>('STORAGE');
  const [maxUnits, setMaxUnits] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => { api.warehouses().then((w) => { setWarehouses(w); if (w[0]) setWhId(w[0].id); }); }, []);
  useEffect(() => { if (whId) api.zones(whId).then((z) => { setZones(z); if (z[0]) setZoneId(z[0].id); }); }, [whId]);
  useEffect(() => { if (zoneId) api.aisles(zoneId).then((a) => { setAisles(a); if (a[0]) setAisleId(a[0].id); }); }, [zoneId]);
  useEffect(() => { if (aisleId) api.racks(aisleId).then((r) => { setRacks(r); if (r[0]) setRackId(r[0].id); }); }, [aisleId]);
  useEffect(() => { if (rackId) api.levels(rackId).then((l) => { setLevels(l); if (l[0]) setLevelId(l[0].id); }); }, [rackId]);

  // Load list whenever search / filters change.
  useEffect(() => {
    const params = { warehouseId: whId || undefined, status: filterStatus || undefined, locationType: filterType || undefined };
    if (search.trim()) api.searchLocations(search.trim(), params).then(setData).catch((e) => setErr(apiErrorMessage(e)));
    else api.locations(params).then(setData).catch((e) => setErr(apiErrorMessage(e)));
  }, [whId, search, filterStatus, filterType]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!canCreate || !levelId || !whId) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      const loc = await api.createLocation({
        warehouseId: whId, zoneId, aisleId, rackId, levelId, locationType: locType,
        ...(maxUnits !== '' ? { maxUnits: Number(maxUnits) } : {}),
      });
      setMsg(`Location ${loc.locationCode} created.`);
      setMaxUnits('');
    } catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }

  async function action(l: Location, a: 'activate' | 'deactivate' | 'block' | 'unblock') {
    setBusyId(l.id);
    try { await api.locationStatus(l.id, a); setMsg(`Location ${l.locationCode}: ${a}d.`); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Locations</h1>
      <p className="page-sub">The final physical place. Code format: WAREHOUSE-ZONE-AISLE-RACK-LEVEL (barcode-ready).</p>

      <div className="card">
        <h3>Create location</h3>
        {msg && <div className="ok-box">{msg}</div>}
        {err && <div className="error-box">{err}</div>}
        {/* Chain selector — the backend validates the full ancestry on submit. */}
        <div className="grid2">
          <div><label>Warehouse</label><select value={whId} onChange={(e) => setWhId(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select></div>
          <div><label>Zone</label><select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>{zones.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}</select></div>
          <div><label>Aisle</label><select value={aisleId} onChange={(e) => setAisleId(e.target.value)}>{aisles.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></div>
          <div><label>Rack</label><select value={rackId} onChange={(e) => setRackId(e.target.value)}>{racks.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}</select></div>
          <div><label>Level</label><select value={levelId} onChange={(e) => setLevelId(e.target.value)}>{levels.map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}</select></div>
        </div>
        {canCreate ? (
          <form onSubmit={create} className="grid2" style={{ marginTop: 12 }}>
            <div><label>Location type</label>
              <select value={locType} onChange={(e) => setLocType(e.target.value as LocationType)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
            </div>
            <div><label>Max units (optional)</label><input type="number" min={0} value={maxUnits} onChange={(e) => setMaxUnits(e.target.value)} /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        ) : <p className="empty">You do not have permission to create locations.</p>}
      </div>

      <div className="card">
        <h3>Search / filter locations</h3>
        <div className="grid2">
          <div><label>Search (code / barcode)</label><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. SHOES-A01" /></div>
          <div><label>Status</label>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}><option value="">All</option><option>ACTIVE</option><option>INACTIVE</option><option>BLOCKED</option></select>
          </div>
          <div><label>Location type</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}><option value="">All</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </div>
        </div>
        <p className="page-sub" style={{ marginTop: 12 }}>{data?.total ?? 0} result(s)</p>
        {data && data.items.length > 0 && (
          <table>
            <thead><tr><th>Location code</th><th>Barcode</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.locationCode}</strong></td>
                  <td>{l.barcodeValue}</td>
                  <td>{l.locationType}</td>
                  <td>{statusTag(l.status)}</td>
                  <td><StatusActions status={l.status} perm="locations" onActivate={() => action(l, 'activate')} onDeactivate={() => action(l, 'deactivate')} onBlock={() => action(l, 'block')} onUnblock={() => action(l, 'unblock')} busy={busyId === l.id} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.items.length === 0 && <p className="empty">No locations match.</p>}
      </div>
    </>
  );
}
