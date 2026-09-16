import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, type DisplayFleet, type DisplayFleetRow } from '../api';
import { apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { displayUrl, relativeTime } from '../../display/display-view';

/**
 * STATION DISPLAYS — FLEET CONSOLE (owner order 2026-09-16, stage 2).
 *
 * «the display must help the worker, show and record every action, let us act
 * from it — include all stations».
 *
 * One screen answers the three fleet questions the per-station panel could not:
 *  1. WHICH stations have a display, which have NONE, which are offline;
 *  2. what each display is ALLOWED to do (read-only vs interactive + actions);
 *  3. bulk control over the whole fleet (create missing / apply profile /
 *     enable-disable all / switch interactivity) from one place.
 *
 * Tokens are never listed: the URL IS the credential, so it is shown once at
 * create/regenerate — an admin who needs it regenerates it deliberately.
 */

const ACTION_FIELDS = [
  { key: 'print', label: 'Print' },
  { key: 'reprint', label: 'Reprint' },
  { key: 'ack', label: 'Ack alert' },
  { key: 'help', label: 'Call supervisor' },
  { key: 'exception', label: 'Report problem' },
  { key: 'message', label: 'Message seen' },
] as const;

const DEFAULT_PROFILE = {
  interactive: false,
  sound: true,
  printTransport: 'BROWSER',
  actions: { print: true, reprint: true, ack: true, help: true, exception: true, message: true, move: false },
};

export default function DisplaysFleet() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stations.manage');

  const [fleet, setFleet] = useState<DisplayFleet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [profile, setProfile] = useState<Record<string, unknown>>({ ...DEFAULT_PROFILE });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [msgTo, setMsgTo] = useState<string | null>(null);
  const [msgBody, setMsgBody] = useState('');
  const [msgSeverity, setMsgSeverity] = useState('INFO');
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [actions, setActions] = useState<Array<{ id: string; kind: string; summary: string | null; createdAt: string; display: { name: string } | null }>>([]);

  const load = useCallback(async () => {
    try { setFleet(await adminApi.displayFleet()); setErr(null); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Live-ish fleet: the offline pill must not lie for a minute after a screen dies.
  useEffect(() => {
    const t = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key); setErr(null); setNote(null);
    try { const msg = await fn(); await load(); if (msg) setNote(msg); }
    catch (ex) { setErr(apiErrorMessage(ex)); }
    finally { setBusy(null); }
  }

  const rows = useMemo(() => {
    const list = fleet?.stations ?? [];
    return onlyGaps ? list.filter((r) => r.displays.length === 0 || r.displays.some((d) => !d.enabled || !d.online)) : list;
  }, [fleet, onlyGaps]);

  const targetIds = useMemo(() => Object.keys(selected).filter((id) => selected[id]), [selected]);
  const targets = targetIds.length > 0 ? targetIds : undefined;

  const bulk = (action: 'CREATE_MISSING' | 'APPLY_CONFIG' | 'SET_ENABLED' | 'SET_INTERACTIVE', extra: Record<string, unknown>) =>
    run(`bulk-${action}`, async () => {
      const res = await adminApi.stationDisplayBulk({ action, stationIds: targets, ...extra } as never);
      const created = res.created ?? [];
      if (created.length > 0) {
        setUrls((u) => {
          const next = { ...u };
          for (const c of created) next[c.displayId] = displayUrl(c.urlPath.replace('/display/', ''));
          return next;
        });
      }
      return `${action}: ${res.applied} display(s) affected${created.length ? ` — ${created.length} URL(s) shown below (copy them now)` : ''}.`;
    });

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNote('URL copied.'); }
    catch { window.prompt('Copy the display URL:', text); }
  }

  const openActions = (stationId: string) => run(`act-${stationId}`, async () => {
    setActionsFor(stationId);
    setActions(await adminApi.stationDisplayActions(stationId, 20));
  });

  const counters = fleet?.counters;

  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Station Displays — Fleet</h1>
        <p className="ac-sub">
          Every station's display in one place: which screens exist, which are live, what each one is
          <b> allowed to do</b> (read-only vs interactive), and fleet-wide actions. Actions taken on a
          screen are audited with that display's identity — open “actions” on a row to see them.
        </p>
      </header>

      {(err) && <div className="ac-error">{err}</div>}
      {note && <div className="os-muted" style={{ margin: '6px 0 10px' }}>{note}</div>}

      <section className="ac-kpis" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        {[
          ['Stations', counters?.stations ?? 0],
          ['With display', counters?.stationsWithDisplay ?? 0],
          ['Without display', counters?.stationsWithoutDisplay ?? 0],
          ['Displays', counters?.displays ?? 0],
          ['Online', counters?.online ?? 0],
          ['Offline', counters?.offline ?? 0],
          ['Disabled', counters?.disabled ?? 0],
          ['Interactive', counters?.interactive ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="os-card" style={{ padding: '10px 16px', minWidth: 120 }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{value as number}</div>
            <div className="os-muted" style={{ fontSize: '0.75rem' }}>{label as string}</div>
          </div>
        ))}
      </section>

      {canManage && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <h2 className="os-card-title">Fleet actions{targets ? ` — ${targets.length} selected` : ' — whole warehouse'}</h2>
          <div className="os-row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <button className="os-btn os-btn--primary" disabled={busy === 'bulk-CREATE_MISSING'}
              onClick={() => void bulk('CREATE_MISSING', { config: profile })}>
              {busy === 'bulk-CREATE_MISSING' ? '…' : '+ Create a display for every station that has none'}
            </button>
            <button className="os-btn" disabled={busy === 'bulk-APPLY_CONFIG'}
              onClick={() => void bulk('APPLY_CONFIG', { config: profile })}>
              Apply profile to all
            </button>
            <button className="os-btn" disabled={busy === 'bulk-SET_ENABLED'}
              onClick={() => void bulk('SET_ENABLED', { enabled: true })}>Enable all screens</button>
            <button className="os-btn" disabled={busy === 'bulk-SET_ENABLED'}
              onClick={() => { if (window.confirm('Disable EVERY display? All screens stop updating (read AND actions).')) void bulk('SET_ENABLED', { enabled: false }); }}>
              Kill switch — disable all
            </button>
            <button className="os-btn" disabled={busy === 'bulk-SET_INTERACTIVE'}
              onClick={() => void bulk('SET_INTERACTIVE', { interactive: true })}>Make interactive</button>
            <button className="os-btn" disabled={busy === 'bulk-SET_INTERACTIVE'}
              onClick={() => void bulk('SET_INTERACTIVE', { interactive: false })}>Make read-only</button>
            <label className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
              <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />
              Only stations with a gap (none / offline / disabled)
            </label>
          </div>

          <div className="os-row" style={{ flexWrap: 'wrap', gap: 14, marginTop: 12, alignItems: 'center' }}>
            <label className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
              <input type="checkbox" checked={profile.interactive === true}
                onChange={(e) => setProfile({ ...profile, interactive: e.target.checked })} />
              Interactive (allow actions from the screen)
            </label>
            <label className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
              <input type="checkbox" checked={profile.sound !== false}
                onChange={(e) => setProfile({ ...profile, sound: e.target.checked })} />
              Sound
            </label>
            <label className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
              Print transport
              <select className="os-input" value={String(profile.printTransport)}
                onChange={(e) => setProfile({ ...profile, printTransport: e.target.value })}>
                <option value="BROWSER">BROWSER (screen's printer)</option>
                <option value="CT40">CT40 (worker handheld bridge)</option>
                <option value="BRIDGE">BRIDGE (local agent)</option>
              </select>
            </label>
            {ACTION_FIELDS.map((a) => {
              const actionsOn = (profile.actions ?? {}) as Record<string, boolean>;
              return (
                <label key={a.key} className="os-row" style={{ gap: 6, fontSize: '0.8rem' }}>
                  <input type="checkbox" checked={actionsOn[a.key] !== false}
                    onChange={(e) => setProfile({ ...profile, actions: { ...actionsOn, [a.key]: e.target.checked } })} />
                  {a.label}
                </label>
              );
            })}
          </div>
          <div className="os-muted" style={{ fontSize: '0.75rem', marginTop: 8 }}>
            The profile above is what “Create missing” and “Apply profile” use. Interactive is OFF by default:
            a screen reaches the backend with its display URL, so write access is an explicit admin decision
            (audited), revocable instantly by disabling the display or regenerating its URL.
          </div>
        </section>
      )}

      <section className="os-card">
        {fleet === null ? <div className="os-empty">loading…</div> : (
          <table className="os-table">
            <thead>
              <tr>
                <th style={{ width: 30 }} />
                <th>Station</th><th>Dept</th><th>Worker</th><th>Display</th><th>State</th>
                <th>Mode</th><th>Last seen</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <FleetRow
                  key={r.stationId}
                  row={r}
                  canManage={canManage}
                  busy={busy}
                  urls={urls}
                  checked={selected[r.stationId] === true}
                  onCheck={(v) => setSelected((s) => ({ ...s, [r.stationId]: v }))}
                  onCopy={copy}
                  onUrl={(id, url) => setUrls((u) => ({ ...u, [id]: url }))}
                  onOpenActions={() => void openActions(r.stationId)}
                  actionsOpen={actionsFor === r.stationId}
                  actions={actions}
                  onMessage={() => { setMsgTo(msgTo === r.stationId ? null : r.stationId); setMsgBody(''); }}
                  messageOpen={msgTo === r.stationId}
                  msgBody={msgBody}
                  msgSeverity={msgSeverity}
                  setMsgBody={setMsgBody}
                  setMsgSeverity={setMsgSeverity}
                  run={run}
                />
              ))}
              {rows.length === 0 && <tr><td colSpan={9} className="os-empty">No station matches this filter.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function FleetRow(props: {
  row: DisplayFleetRow;
  canManage: boolean;
  busy: string | null;
  urls: Record<string, string>;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onCopy: (text: string) => void;
  onUrl: (displayId: string, url: string) => void;
  onOpenActions: () => void;
  actionsOpen: boolean;
  actions: Array<{ id: string; kind: string; summary: string | null; createdAt: string; display: { name: string } | null }>;
  onMessage: () => void;
  messageOpen: boolean;
  msgBody: string;
  msgSeverity: string;
  setMsgBody: (v: string) => void;
  setMsgSeverity: (v: string) => void;
  run: (key: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const { row, canManage, busy, urls } = props;
  const active = row.displays.find((d) => d.enabled) ?? null;
  const display = active ?? row.displays[0] ?? null;

  return (
    <>
      <tr>
        <td>
          {canManage && (
            <input type="checkbox" checked={props.checked} onChange={(e) => props.onCheck(e.target.checked)} />
          )}
        </td>
        <td>
          <div className="mono"><b>{row.stationCode}</b></div>
          <div className="os-muted" style={{ fontSize: '0.75rem' }}>{row.stationName}</div>
        </td>
        <td className="os-muted" style={{ fontSize: '0.75rem' }}>{row.department}</td>
        <td className="os-muted" style={{ fontSize: '0.75rem' }}>
          {row.worker ? `${row.worker.code} · ${row.worker.name}` : '—'}
        </td>
        <td>
          {display ? (
            <div>
              <div style={{ fontSize: '0.85rem' }}>{display.name}</div>
              {urls[display.id] ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code style={{ fontSize: '0.68rem' }}>{urls[display.id]}</code>
                  <button className="ac-linkbtn" onClick={() => props.onCopy(urls[display.id])}>Copy</button>
                  <a className="ac-linkbtn" href={urls[display.id]} target="_blank" rel="noreferrer">Open</a>
                </div>
              ) : canManage ? (
                <button className="ac-linkbtn" disabled={busy === `reg-${display.id}`}
                  onClick={() => void props.run(`reg-${display.id}`, async () => {
                    const d = await adminApi.regenerateStationDisplay(display.id);
                    props.onUrl(display.id, displayUrl(d.accessToken));
                    return 'Access regenerated — the OLD URL stopped working. Copy the new URL from the row.';
                  })}>
                  {busy === `reg-${display.id}` ? '…' : 'Get URL (regenerates — old dies)'}
                </button>
              ) : null}
            </div>
          ) : <span className="os-muted">no display</span>}
        </td>
        <td>
          {!display ? <span className="os-tag os-tag--muted">NONE</span> : (
            <>
              <span className={`os-tag ${!display.enabled ? 'os-tag--muted' : display.online ? 'os-tag--ok' : ''}`}>
                {!display.enabled ? 'Disabled' : display.online ? 'Online' : 'Offline'}
              </span>
              {row.displays.length > 1 && <span className="os-muted" style={{ fontSize: '0.7rem' }}> +{row.displays.length - 1}</span>}
            </>
          )}
        </td>
        <td>
          {display ? (
            <span className="os-muted" style={{ fontSize: '0.75rem' }}>
              {display.interactive ? '⚡ interactive' : '👁 read-only'} · {display.printTransport}
            </span>
          ) : '—'}
        </td>
        <td className="os-muted" style={{ fontSize: '0.75rem' }}>{display ? relativeTime(display.lastSeenAt) : '—'}</td>
        <td style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {canManage && (
            <>
              {!display && (
                <button className="ac-linkbtn" disabled={busy === `mk-${row.stationId}`}
                  onClick={() => void props.run(`mk-${row.stationId}`, async () => {
                    const d = await adminApi.createStationDisplay(row.stationId, {});
                    props.onUrl(d.id, displayUrl(d.accessToken));
                    return `Display created for ${row.stationCode} — copy its URL from the row now.`;
                  })}>
                  {busy === `mk-${row.stationId}` ? '…' : 'Create display'}
                </button>
              )}
              {display && (
                <>
                  <button className="ac-linkbtn" disabled={busy === `en-${display.id}`}
                    onClick={() => void props.run(`en-${display.id}`, async () => {
                      await adminApi.updateStationDisplay(display.id, { enabled: !display.enabled });
                    })}>
                    {display.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="ac-linkbtn" disabled={busy === `int-${display.id}`}
                    onClick={() => void props.run(`int-${display.id}`, async () => {
                      await adminApi.updateStationDisplay(display.id, { config: { ...display.visibility, interactive: !display.interactive, actions: display.actions, printTransport: display.printTransport } });
                      return display.interactive ? 'Screen is now READ-ONLY.' : 'Screen can now ACT (print/ack/help/exception) — audited.';
                    })}>
                    {display.interactive ? 'Make read-only' : 'Make interactive'}
                  </button>
                  <button className="ac-linkbtn" onClick={props.onMessage}>Message</button>
                  <button className="ac-linkbtn" onClick={props.onOpenActions}>Actions</button>
                  <button className="ac-linkbtn" style={{ color: '#ff5d5d' }} disabled={busy === `del-${display.id}`}
                    onClick={() => { if (window.confirm('Delete this display? Its URL stops working.')) void props.run(`del-${display.id}`, async () => { await adminApi.deleteStationDisplay(display.id); }); }}>
                    Delete
                  </button>
                </>
              )}
            </>
          )}
        </td>
      </tr>

      {props.messageOpen && display && (
        <tr>
          <td />
          <td colSpan={8}>
            <div className="os-card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="os-input" style={{ flex: 1, minWidth: 260 }} placeholder="Message to the station screen…"
                value={props.msgBody} onChange={(e) => props.setMsgBody(e.target.value)} />
              <select className="os-input" value={props.msgSeverity} onChange={(e) => props.setMsgSeverity(e.target.value)}>
                <option value="INFO">INFO</option>
                <option value="WARNING">WARNING</option>
                <option value="URGENT">URGENT</option>
              </select>
              <button className="os-btn os-btn--primary" disabled={!props.msgBody.trim() || busy === `msg-${display.id}`}
                onClick={() => void props.run(`msg-${display.id}`, async () => {
                  await adminApi.sendStationDisplayMessage(display.id, { body: props.msgBody, severity: props.msgSeverity });
                  props.setMsgBody('');
                  props.onMessage();
                  return 'Message sent — the screen shows it until someone taps SEEN.';
                })}>
                Send
              </button>
            </div>
          </td>
        </tr>
      )}

      {props.actionsOpen && (
        <tr>
          <td />
          <td colSpan={8}>
            <div className="os-card">
              <b style={{ fontSize: '0.85rem' }}>Actions taken on this station's screens (last 20)</b>
              {props.actions.length === 0 ? <div className="os-empty">No action recorded yet.</div> : (
                <table className="os-table">
                  <thead><tr><th>When</th><th>Screen</th><th>Action</th><th>Detail</th></tr></thead>
                  <tbody>
                    {props.actions.map((a) => (
                      <tr key={a.id}>
                        <td className="os-muted" style={{ fontSize: '0.75rem' }}>{new Date(a.createdAt).toLocaleString()}</td>
                        <td className="os-muted" style={{ fontSize: '0.75rem' }}>{a.display?.name ?? '—'}</td>
                        <td><span className="os-tag">{a.kind}</span></td>
                        <td className="os-muted" style={{ fontSize: '0.75rem' }}>{a.summary ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
