import { useEffect, useState } from 'react';
import { adminApi } from '../api';
import { useAsync } from './useAsync';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { displayUrl, isDisplayOnline, relativeTime } from '../../display/display-view';
import { VIEW_LABELS, type DisplayView } from '../../display/display-view';

const DEPARTMENTS = ['RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH', 'STAGING', 'BATCH'];
const CAPS = ['CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'PRINTER', 'SCALE'];

/** §4 Data Visibility — every switch is configurable per display.
 * `recent` was missing from this list although the backend has supported it
 * since the owner asked for the «ALL actions» feed (fix 2026-09-16 stage 2):
 * the admin could not switch the feed on. `reports` stays visible-but-reserved
 * so nobody wonders where it went (v1 never emits a reports section). */
/** v3 SCREEN ROLES — what a single physical screen is FOR. The server enforces
 * the role too (`VIEW_PRESETS`): a screen set to ALERTS physically cannot
 * receive the queue or the stats, even if the switches below stay on. */
const VIEW_OPTIONS: DisplayView[] = ['BOARD', 'ACTION', 'QUEUE', 'ALERTS', 'PRINT', 'STATS'];

const DISPLAY_FIELDS: Array<{ key: string; label: string; reserved?: boolean }> = [
  { key: 'worker', label: 'Worker' },
  { key: 'operation', label: 'Current Operation' },
  { key: 'task', label: 'Current Task' },
  { key: 'lastScan', label: 'Last Scan' },
  { key: 'product', label: 'Product' },
  { key: 'customer', label: 'Customer' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'status', label: 'Transaction Status' },
  { key: 'progress', label: 'Progress' },
  { key: 'station', label: 'Current Station' },
  { key: 'recent', label: 'Recent actions feed' },
  // ASSIST LAYER (owner order 2026-09-16): «the screens must show everything
  // about the station and help the worker» — the next action, what is still
  // expected, what is wrong, and the shift totals. Each one is switchable.
  { key: 'guidance', label: 'Next action (what to do NOW)' },
  { key: 'queue', label: 'Still expected (queue)' },
  { key: 'alerts', label: 'Open problems / supervisor calls' },
  { key: 'stats', label: 'Shift totals' },
  { key: 'reports', label: 'Reports (reserved — v1 off)', reserved: true },
];

/** STAGE 2 — what the screen may DO. Default: nothing (read-only). */
const DISPLAY_ACTIONS: Array<{ key: string; label: string }> = [
  { key: 'print', label: 'Print label' },
  { key: 'reprint', label: 'Reprint' },
  { key: 'ack', label: 'Ack alert' },
  { key: 'help', label: 'Call supervisor' },
  { key: 'exception', label: 'Report problem' },
  { key: 'message', label: 'Message seen' },
];

type DisplayRow = {
  id: string; name: string; enabled: boolean; displayType: string;
  lastSeenAt: string | null; createdAt: string; config: Record<string, unknown>;
};

/** Station → Display Mode panel (owner order 2026-09-16): create/configure/
 * open/copy/regenerate/disable/delete read-only live displays. A display is
 * a capability OF the station — never a station itself. */
function StationDisplaysPanel({ stationId, stationName, canManage }: { stationId: string; stationName: string; canManage: boolean }) {
  const [displays, setDisplays] = useState<DisplayRow[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, Record<string, unknown>>>({});
  const [msgFor, setMsgFor] = useState<string | null>(null);
  const [msgBody, setMsgBody] = useState('');
  const [msgSeverity, setMsgSeverity] = useState('INFO');

  const load = async () => {
    try { setDisplays(await adminApi.stationDisplays(stationId)); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
  };
  useEffect(() => { setDisplays(null); setUrls({}); setErr(null); setNote(null); void load(); /* eslint-disable-line */ }, [stationId]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setErr(null); setNote(null);
    try { await fn(); await load(); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
    finally { setBusy(null); }
  }

  const create = () => run('create', async () => {
    const d = await adminApi.createStationDisplay(stationId, {});
    setUrls((u) => ({ ...u, [d.id]: displayUrl(d.accessToken) }));
    setNote(`Display created — copy its URL now (shown once per create/regenerate).`);
  });

  const regenerate = (id: string) => run(`reg-${id}`, async () => {
    const d = await adminApi.regenerateStationDisplay(id);
    setUrls((u) => ({ ...u, [d.id]: displayUrl(d.accessToken) }));
    setNote('Access regenerated — the old display URL no longer works.');
  });

  /** FLAT switch (visibility + flags) — merged over the stored config. */
  const toggleConfig = (id: string, key: string, current: Record<string, unknown>) =>
    setEditing((e) => {
      const merged: Record<string, unknown> = { ...(e[id] ?? {}) };
      merged[key] = !((e[id] ?? current)[key] === true);
      return { ...e, [id]: merged };
    });

  /** NESTED switch (config.actions.*) — what this screen is allowed to DO. */
  const toggleAction = (id: string, key: string, current: Record<string, unknown>) =>
    setEditing((e) => {
      const editingRow = (e[id] ?? {}) as Record<string, unknown>;
      const base = ((editingRow.actions ?? current.actions ?? {}) as Record<string, boolean>);
      const merged: Record<string, unknown> = { ...editingRow, actions: { ...base, [key]: !(base[key] === true) } };
      return { ...e, [id]: merged };
    });

  const saveConfig = (d: DisplayRow) => run(`cfg-${d.id}`, async () => {
    const patch = editing[d.id] ?? {};
    const config = {
      ...d.config,
      ...patch,
      ...(patch.actions ? { actions: { ...((d.config.actions ?? {}) as Record<string, boolean>), ...(patch.actions as Record<string, boolean>) } } : {}),
    } as Record<string, unknown>;
    await adminApi.updateStationDisplay(d.id, { config });
    setEditing((e) => { const n = { ...e }; delete n[d.id]; return n; });
    setNote('Display configuration saved.');
  });

  const sendMessage = (displayId: string) => run(`msg-${displayId}`, async () => {
    await adminApi.sendStationDisplayMessage(displayId, { body: msgBody, severity: msgSeverity });
    setMsgBody('');
    setMsgFor(null);
    setNote('Message sent — the screen shows it until someone taps SEEN.');
  });

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNote('URL copied.'); }
    catch { window.prompt('Copy the display URL:', text); }
  }

  return (
    <section className="os-card" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>Display Mode — {stationName}</h3>
          <div className="os-muted" style={{ fontSize: '0.8rem' }}>
            Live view of this station's transactions. Open the URL on any screen (PC / TV / tablet).
            Interactive actions (print / ack / help / exception) are opt-in per display — fleet view on
            {' '}<a className="ac-linkbtn" href="/admin/displays">Station Displays</a>.
          </div>
        </div>
        {canManage && (
          <button className="os-btn os-btn--primary" disabled={busy === 'create'} onClick={create}>
            {busy === 'create' ? 'creating…' : '+ Create Display'}
          </button>
        )}
      </div>

      {err && <div className="os-tag os-tag--muted" style={{ color: '#ff5d5d', marginTop: 8 }}>{err}</div>}
      {note && <div className="os-muted" style={{ marginTop: 8, fontSize: '0.8rem' }}>{note}</div>}

      {displays === null ? <div className="os-empty">loading…</div> : displays.length === 0 ? (
        <div className="os-empty">No displays for this station yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {displays.map((d) => {
            const online = isDisplayOnline(d.lastSeenAt);
            const url = urls[d.id];
            const edited = (editing[d.id] ?? {}) as Record<string, unknown>;
            const cfg = { ...d.config, ...edited } as Record<string, unknown>;
            const cfgActions = { ...((d.config.actions ?? {}) as Record<string, boolean>), ...((edited.actions ?? {}) as Record<string, boolean>) };
            const interactive = cfg.interactive === true;
            return (
              <div key={d.id} style={{ border: '1px solid var(--line, #24303d)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span className={`os-tag ${online && d.enabled ? 'os-tag--ok' : 'os-tag--muted'}`}>
                    {d.enabled ? (online ? 'Connected' : 'Offline') : 'Disabled'}
                  </span>
                  <b>{d.name}</b>
                  <span className="os-muted" style={{ fontSize: '0.75rem' }}>
                    {d.displayType} · last seen {relativeTime(d.lastSeenAt)}
                  </span>
                  <span style={{ flex: 1 }} />
                  {url ? (
                    <>
                      <code style={{ fontSize: '0.72rem' }}>{url}</code>
                      <button className="ac-linkbtn" onClick={() => void copy(url)}>Copy URL</button>
                      <a className="ac-linkbtn" href={url} target="_blank" rel="noreferrer">Open Display</a>
                    </>
                  ) : canManage ? (
                    <button className="ac-linkbtn" disabled={busy === `reg-${d.id}`} onClick={() => void regenerate(d.id)}>
                      {busy === `reg-${d.id}` ? '…' : 'Get URL (regenerate access)'}
                    </button>
                  ) : null}
                  {canManage && (
                    <>
                      <button className="ac-linkbtn" disabled={busy === `en-${d.id}`}
                        onClick={() => void run(`en-${d.id}`, async () => { await adminApi.updateStationDisplay(d.id, { enabled: !d.enabled }); })}>
                        {d.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button className="ac-linkbtn" style={{ color: '#ff5d5d' }} disabled={busy === `del-${d.id}`}
                        onClick={() => { if (window.confirm('Delete this display? Its URL stops working.')) void run(`del-${d.id}`, async () => { await adminApi.deleteStationDisplay(d.id); }); }}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
                <div className="os-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  {DISPLAY_FIELDS.map((f) => (
                    <label key={f.key} className="os-row" style={{ gap: 5, fontSize: '0.78rem', opacity: f.reserved ? 0.55 : 1 }}>
                      <input type="checkbox"
                        checked={f.reserved ? cfg[f.key] === true : cfg[f.key] !== false}
                        disabled={!canManage || f.reserved || busy === `cfg-${d.id}`}
                        onChange={() => toggleConfig(d.id, f.key, d.config)} />
                      {f.label}
                    </label>
                  ))}
                </div>

                {/* STAGE 2 — assist & control from the screen */}
                <div className="os-row" style={{ flexWrap: 'wrap', gap: 10, borderTop: '1px dashed var(--line, #24303d)', paddingTop: 8 }}>
                  <label className="os-row" style={{ gap: 5, fontSize: '0.78rem', fontWeight: 700, color: '#7cc4ff' }}
                    title="One screen, one job — like the pick-to-light faces of an Amazon FC. The role also filters the payload server-side.">
                    🖥 Screen role
                    <select className="os-input" style={{ fontSize: '0.75rem' }} value={String(cfg.view ?? 'BOARD')}
                      disabled={!canManage || busy === `cfg-${d.id}`} data-testid={`view-${d.id}`}
                      onChange={(e) => setEditing((x) => ({ ...x, [d.id]: { ...(x[d.id] ?? {}), view: e.target.value } }))}>
                      {VIEW_OPTIONS.map((v) => <option key={v} value={v}>{VIEW_LABELS[v]}</option>)}
                    </select>
                  </label>
                  <label className="os-row" style={{ gap: 5, fontSize: '0.78rem', fontWeight: 600 }}>
                    <input type="checkbox" checked={interactive} disabled={!canManage || busy === `cfg-${d.id}`}
                      onChange={() => toggleConfig(d.id, 'interactive', d.config)} />
                    ⚡ Interactive (allow actions from this screen)
                  </label>
                  <label className="os-row" style={{ gap: 5, fontSize: '0.78rem' }}>
                    <input type="checkbox" checked={cfg.sound !== false} disabled={!canManage || busy === `cfg-${d.id}`}
                      onChange={() => toggleConfig(d.id, 'sound', d.config)} />
                    🔔 Sound
                  </label>
                  <label className="os-row" style={{ gap: 5, fontSize: '0.78rem' }}>
                    Print via
                    <select className="os-input" style={{ fontSize: '0.75rem' }} value={String(cfg.printTransport ?? 'BROWSER')}
                      disabled={!canManage || busy === `cfg-${d.id}`}
                      onChange={(e) => setEditing((x) => ({ ...x, [d.id]: { ...(x[d.id] ?? {}), printTransport: e.target.value } }))}>
                      <option value="BROWSER">BROWSER (screen's printer)</option>
                      <option value="CT40">CT40 (worker handheld bridge)</option>
                      <option value="BRIDGE">BRIDGE (local agent)</option>
                    </select>
                  </label>
                  {interactive && DISPLAY_ACTIONS.map((a) => (
                    <label key={a.key} className="os-row" style={{ gap: 5, fontSize: '0.78rem' }}>
                      <input type="checkbox" checked={cfgActions[a.key] === true}
                        disabled={!canManage || busy === `cfg-${d.id}`}
                        onChange={() => toggleAction(d.id, a.key, d.config)} />
                      {a.label}
                    </label>
                  ))}
                </div>
                {interactive && (
                  <div className="os-muted" style={{ fontSize: '0.72rem' }}>
                    An interactive display reaches the backend with this URL — write access is an explicit,
                    audited admin decision, and it dies instantly when you disable this display or regenerate
                    its access. Every action records which screen did it.
                  </div>
                )}
                <div className="os-muted" style={{ fontSize: '0.72rem' }}>
                  Role ≠ Board keeps this screen single-purpose: the server sends only the blocks that role needs
                  (ACTION = one instruction, ALERTS = andon only, PRINT = labels only, STATS = numbers only), so the
                  operator reads one thing from across the aisle. One station normally carries a SET of screens —
                  build it from the Displays fleet page.
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="ac-linkbtn" onClick={() => { setMsgFor(msgFor === d.id ? null : d.id); setMsgBody(''); }}>
                      ✉ Message the screen
                    </button>
                  </div>
                )}
                {msgFor === d.id && (
                  <div className="os-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <input className="os-input" style={{ flex: 1, minWidth: 240 }} placeholder="Message shown on the station screen…"
                      value={msgBody} onChange={(e) => setMsgBody(e.target.value)} />
                    <select className="os-input" value={msgSeverity} onChange={(e) => setMsgSeverity(e.target.value)}>
                      <option value="INFO">INFO</option>
                      <option value="WARNING">WARNING</option>
                      <option value="URGENT">URGENT</option>
                    </select>
                    <button className="os-btn os-btn--primary" disabled={!msgBody.trim() || busy === `msg-${d.id}`}
                      onClick={() => void sendMessage(d.id)}>Send</button>
                  </div>
                )}
                {canManage && editing[d.id] && (
                  <div><button className="os-btn" disabled={busy === `cfg-${d.id}`} onClick={() => void saveConfig(d)}>
                    {busy === `cfg-${d.id}` ? 'saving…' : 'Save configuration'}
                  </button></div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Station registry + worker assignment + station/zone configuration (S10/S11).
 *
 * Master Order S11: the station→zone relationship (which temporary-storage
 * zone closed totes wait at) is BACKEND/ADMIN CONFIGURATION, not code. This
 * page is that configuration surface: department + zone are validated and
 * audited by the backend.
 */
export default function Stations() {
  const stations = useAsync(() => adminApi.stations(), []);
  const workers = useAsync(() => adminApi.workers().catch(() => []), []);
  const warehouses = useAsync(() => adminApi.warehouses().catch(() => []), []);
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stations.manage');

  const [zones, setZones] = useState<Array<{ id: string; code: string }>>([]);
  const whId = warehouses.data?.[0]?.id ?? '';
  useEffect(() => {
    if (whId) adminApi.zones(whId).then(setZones).catch(() => setZones([]));
  }, [whId]);

  const [displayStation, setDisplayStation] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState({ code: '', name: '', department: 'RECEIVING', capabilities: ['CAMERA'] as string[], zoneId: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await adminApi.createStation({ ...form, zoneId: form.zoneId || undefined });
      setForm({ code: '', name: '', department: 'RECEIVING', capabilities: ['CAMERA'], zoneId: '' });
      await stations.reload();
    } catch (ex) { setErr(apiErrorMessage(ex)); } finally { setBusy(false); }
  }

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try { await fn(); await stations.reload(); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
  }

  const toggleCap = (c: string) =>
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(c)
        ? f.capabilities.filter((x) => x !== c)
        : [...f.capabilities, c],
    }));

  const zoneOptions = (
    <>
      <option value="">— no zone —</option>
      {zones.map((z) => <option key={z.id} value={z.id}>{z.code}</option>)}
    </>
  );

  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Stations</h1>
        <p className="ac-sub">
          Physical work positions, their hardware capabilities and assigned worker.
          Department + zone are audited configuration (S11) — STAGING stations define where
          closed totes wait in temporary storage.
        </p>
      </header>

      {(err || stations.error) && <div className="ac-error">{err ?? stations.error}</div>}

      {canManage && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <h2 className="os-card-title">Create station</h2>
          <form onSubmit={create} className="os-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', alignItems: 'end' }}>
            <div>
              <label className="os-label" htmlFor="st-code">Code</label>
              <input id="st-code" className="os-input" value={form.code} required
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="ST-REC-03" />
            </div>
            <div>
              <label className="os-label" htmlFor="st-name">Name</label>
              <input id="st-name" className="os-input" value={form.name} required
                onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Receiving Dock 3" />
            </div>
            <div>
              <label className="os-label" htmlFor="st-dept">Department</label>
              <select id="st-dept" className="os-input" value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="os-label" htmlFor="st-zone">Zone</label>
              <select id="st-zone" className="os-input" value={form.zoneId}
                onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
                {zoneOptions}
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <span className="os-label">Capabilities</span>
              <div className="os-row" style={{ flexWrap: 'wrap' }}>
                {CAPS.map((c) => (
                  <label key={c} className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
                    <input type="checkbox" checked={form.capabilities.includes(c)} onChange={() => toggleCap(c)} />
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <div><button className="os-btn os-btn--primary" type="submit" disabled={busy}>Create</button></div>
          </form>
        </section>
      )}

      <section className="os-card">
        {stations.loading && !stations.data ? <div className="os-empty">loading…</div> : (
          <table className="os-table">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Department</th><th>Zone</th><th>Capabilities</th><th>Worker</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {(stations.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td>
                  <td>{s.name}</td>
                  <td>
                    {canManage ? (
                      <select
                        className="os-input"
                        value={s.department}
                        onChange={(e) => act(() => adminApi.updateStation(s.id, { department: e.target.value }))}
                      >
                        {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    ) : <span className="os-muted">{s.department}</span>}
                  </td>
                  <td>
                    {canManage ? (
                      <select
                        className="os-input"
                        value={s.zone?.id ?? ''}
                        onChange={(e) => act(() => adminApi.updateStation(s.id, { zoneId: e.target.value || null }))}
                      >
                        {zoneOptions}
                      </select>
                    ) : <span className="os-muted mono">{s.zone?.code ?? '—'}</span>}
                  </td>
                  <td className="os-muted" style={{ fontSize: '0.72rem' }}>{s.capabilities.join(' · ') || '—'}</td>
                  <td>
                    {canManage ? (
                      <select
                        className="os-input"
                        value={s.assignedWorker?.id ?? ''}
                        onChange={(e) => act(() => adminApi.assignStation(s.id, e.target.value || null))}
                      >
                        <option value="">— unassigned —</option>
                        {(workers.data ?? []).map((w) => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                    ) : (s.assignedWorker?.name ?? <span className="os-muted">unassigned</span>)}
                  </td>
                  <td>
                    <span className={`os-tag ${s.status === 'ACTIVE' ? 'os-tag--ok' : 'os-tag--muted'}`}>{s.status}</span>
                  </td>
                  <td style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {canManage && (
                      <>
                        <button className="ac-linkbtn" onClick={() => setDisplayStation(displayStation?.id === s.id ? null : { id: s.id, name: s.name })}>
                          Display Mode
                        </button>
                        <button className="ac-linkbtn"
                          onClick={() => act(() => adminApi.stationStatus(s.id, s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'))}>
                          {s.status === 'ACTIVE' ? 'deactivate' : 'activate'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {stations.data?.length === 0 && <tr><td colSpan={8} className="os-empty">No stations yet.</td></tr>}
            </tbody>
          </table>
        )}
      </section>

      {displayStation && canManage && (
        <StationDisplaysPanel stationId={displayStation.id} stationName={displayStation.name} canManage={canManage} />
      )}
    </>
  );
}
