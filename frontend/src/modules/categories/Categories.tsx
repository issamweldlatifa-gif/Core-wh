import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { categoriesApi, type Category } from './api';
import { api as whApi, type Warehouse, type Zone } from '../warehouse/api';

/**
 * Category Master + Sorting configuration.
 *
 * The master is the controlled vocabulary CRM cards are validated against;
 * the Zone mapping is the Category -> Sorting destination CONFIGURATION the
 * putaway/sorting queue reads at runtime. Nothing here is hardcoded in the
 * workflows — admins own this table.
 */
export default function Categories() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('inventory.manage');

  const [rows, setRows] = useState<Category[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [whId, setWhId] = useState('');
  const [zones, setZones] = useState<Zone[]>([]);
  const [form, setForm] = useState({ code: '', name: '', subcategories: '' });
  const [mapZone, setMapZone] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => categoriesApi.list().then(setRows).catch((e) => setErr(apiErrorMessage(e)));

  useEffect(() => { reload(); }, []);
  useEffect(() => {
    whApi.warehouses().then((w) => { setWarehouses(w); if (w[0]) setWhId((cur) => cur || w[0].id); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!whId) { setZones([]); return; }
    whApi.zones(whId).then(setZones).catch((e) => setErr(apiErrorMessage(e)));
  }, [whId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      await categoriesApi.create({
        code: form.code,
        name: form.name || undefined,
        subcategories: form.subcategories
          ? form.subcategories.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
      });
      setMsg('Category created.');
      setForm({ code: '', name: '', subcategories: '' });
      reload();
    } catch (ex) { setErr(apiErrorMessage(ex)); } finally { setSaving(false); }
  }

  async function toggle(c: Category) {
    setBusyId(c.id); setErr(null);
    try { await categoriesApi.setStatus(c.id, c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'); reload(); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  async function setMapping(c: Category) {
    const zoneId = mapZone[c.id];
    if (!zoneId) return;
    setBusyId(c.id); setErr(null);
    try { await categoriesApi.setMapping(c.id, zoneId); setMsg(`Destination set for ${c.code}.`); reload(); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  async function removeMapping(c: Category, zoneId: string) {
    setBusyId(c.id); setErr(null);
    try { await categoriesApi.removeMapping(c.id, zoneId); reload(); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusyId(null); }
  }

  return (
    <>
      <h1 className="page-title">Categories</h1>
      <p className="page-sub">
        Category Master — the controlled vocabulary CRM cards are validated against — and the
        Category → Sorting-Zone destination configuration used by the Putaway queue.
        Unknown or inactive categories arriving on a card become NEEDS REVIEW; they are never guessed.
      </p>

      {err && <div className="error-box">{err}</div>}
      {msg && <div className="error-box" style={{ borderColor: 'var(--success)', color: '#47d08c' }}>{msg}</div>}

      {canManage && (
        <div className="card">
          <h3>Create category</h3>
          <form onSubmit={save} className="grid2">
            <div><label>Code</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="SHOES" required /></div>
            <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Shoes" /></div>
            <div><label>Subcategories (comma-separated, optional)</label><input value={form.subcategories} onChange={(e) => setForm({ ...form, subcategories: e.target.value.toUpperCase() })} placeholder="SPORTS, CASUAL" /></div>
            <div><button className="btn" type="submit" disabled={saving}>{saving ? <span className="spinner" /> : null} Create</button></div>
          </form>
        </div>
      )}

      <div className="card">
        <h3>Sorting destination (per warehouse)</h3>
        <label>Warehouse</label>
        <select value={whId} onChange={(e) => setWhId(e.target.value)}>
          {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </select>
      </div>

      <div className="card">
        <h3>Category Master</h3>
        {rows.length === 0 && <p className="empty">No categories yet. CRM card categories will stay NEEDS REVIEW until the master is populated.</p>}
        {rows.length > 0 && (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Subcategories</th><th>Status</th><th>Sorting destination</th>{canManage && <th>Actions</th>}</tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.code}</strong></td>
                  <td>{c.name}</td>
                  <td>{c.subcategories.length > 0 ? c.subcategories.join(', ') : <span className="empty">any</span>}</td>
                  <td><span className={`tag ${c.status === 'ACTIVE' ? 'green' : 'yellow'}`}>{c.status}</span></td>
                  <td>
                    {c.zoneMappings.length === 0 && <span className="tag yellow">NOT CONFIGURED</span>}
                    {c.zoneMappings.map((m) => (
                      <span key={m.id} className="tag green" style={{ marginRight: 6 }}>
                        → {m.zone.code}
                        {canManage && (
                          <button
                            type="button"
                            className="btn-link"
                            style={{ marginLeft: 6 }}
                            disabled={busyId === c.id}
                            onClick={() => void removeMapping(c, m.zoneId)}
                            title="Remove mapping"
                          >×</button>
                        )}
                      </span>
                    ))}
                  </td>
                  {canManage && (
                    <td>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select
                          value={mapZone[c.id] ?? ''}
                          onChange={(e) => setMapZone({ ...mapZone, [c.id]: e.target.value })}
                          style={{ minWidth: 120 }}
                        >
                          <option value="">zone…</option>
                          {zones.filter((z) => z.status === 'ACTIVE').map((z) => (
                            <option key={z.id} value={z.id}>{z.code}</option>
                          ))}
                        </select>
                        <button className="btn" type="button" disabled={busyId === c.id || !mapZone[c.id]} onClick={() => void setMapping(c)}>Set destination</button>
                        <button className="btn" type="button" disabled={busyId === c.id} onClick={() => void toggle(c)}>
                          {c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
