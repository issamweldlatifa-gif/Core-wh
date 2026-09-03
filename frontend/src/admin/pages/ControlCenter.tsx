import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  adminApi,
  type ActivityRow,
  type ExceptionRow,
  type OpsOverview,
  type WorkerRow,
} from '../api';

/**
 * ADMIN CONTROL CENTER V1 — Warehouse Control Room (§4–§9).
 *
 * A. WAREHOUSE STATUS   — backend counters only.
 * B. OPERATION PIPELINE — RECEIVING → … → SHIPPING, every number from
 *    /operations/overview; metrics without a backend source render "n/a".
 * C. OPERATIONS panels  — per-area status with [OPEN] into existing routes.
 * D. WORKERS + STATIONS — live floor staff and station map.
 * E. EXCEPTIONS         — open discrepancies (severity derived from type).
 * F. LIVE ACTIVITY      — latest audit events, polled (no WS in V1).
 *
 * Exactly FOUR requests per refresh (overview, workers, exceptions,
 * activity), polled every 30 s — no request storms (§15). NO invented
 * data anywhere (§13).
 */

/** Severity is DERIVED from discrepancy type (backend has no severity field). */
function severityOf(type: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  switch (type) {
    case 'WRONG_SHIPMENT':
    case 'UNKNOWN_CARTON':
      return 'CRITICAL';
    case 'SHORTAGE':
    case 'MISSING_CARTON':
    case 'MISSING_PRODUCT':
      return 'HIGH';
    case 'OVERAGE':
    case 'UNEXPECTED_PRODUCT':
    case 'IDENTIFICATION_ERROR':
      return 'MEDIUM';
    default:
      return 'LOW'; // DUPLICATE_SCAN, OTHER
  }
}
const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
const SEV_TAG = {
  CRITICAL: 'os-tag--err', HIGH: 'os-tag--err', MEDIUM: 'os-tag--warn', LOW: 'os-tag--muted',
} as const;

function stationTone(status: string, hasWorker: boolean) {
  if (status === 'MAINTENANCE') return { cls: 'os-tag--warn', label: 'ATTENTION' };
  if (status === 'INACTIVE') return { cls: 'os-tag--muted', label: 'OFFLINE' };
  return hasWorker ? { cls: 'os-tag--ok', label: 'ACTIVE' } : { cls: 'os-tag--muted', label: 'IDLE' };
}

function since(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ControlCenter() {
  const [ov, setOv] = useState<OpsOverview | null>(null);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [exceptions, setExceptions] = useState<ExceptionRow[] | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [activityDenied, setActivityDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    // Four aggregate calls, in parallel; each failure degrades its own
    // section instead of blanking the whole control room.
    const [o, w, x, a] = await Promise.allSettled([
      adminApi.overview(),
      adminApi.workers(),
      adminApi.exceptions('OPEN'),
      adminApi.activity(30),
    ]);
    if (o.status === 'fulfilled') { setOv(o.value); setError(null); }
    else setError('Failed to load floor overview.');
    if (w.status === 'fulfilled') setWorkers(w.value);
    if (x.status === 'fulfilled') setExceptions(x.value);
    if (a.status === 'fulfilled') setActivity(a.value);
    else if ((a.reason as any)?.response?.status === 403) setActivityDenied(true);
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (error && !ov) return <div className="ac-error">{error}</div>;
  if (!ov) return <div className="os-empty">loading control room…</div>;

  const c = ov.counters;

  // Workers actually working right now (derived from live sessions — the
  // user record status alone cannot distinguish ACTIVE from IDLE).
  const busyWorkerIds = new Set(
    [...ov.activeSessions, ...ov.putawaySessions]
      .map((s) => s.worker?.id)
      .filter(Boolean) as string[],
  );
  const taskByWorker = new Map<string, string>();
  ov.activeSessions.forEach((s) => s.worker?.id && taskByWorker.set(s.worker.id, `RECEIVING ${s.code}`));
  ov.putawaySessions.forEach((p) => p.worker?.id && taskByWorker.set(p.worker.id, `PUTAWAY ${p.code}`));

  const sortedExceptions = [...(exceptions ?? [])].sort(
    (a, b) => SEV_ORDER[severityOf(a.type)] - SEV_ORDER[severityOf(b.type)],
  );
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  sortedExceptions.forEach((x) => { sevCounts[severityOf(x.type)] += 1; });

  /** B. OPERATION PIPELINE (§4B) — all values backend counters, "n/a" otherwise. */
  const pipeline: Array<{
    key: string; title: string; to: string;
    rows: Array<{ k: string; v: number | null; tone?: 'ok' | 'warn' | 'err' }>;
  }> = [
    { key: 'rcv', title: 'RECEIVING', to: '/admin/exceptions', rows: [
      { k: 'ACTIVE', v: c.activeSessions, tone: c.activeSessions ? 'ok' : undefined },
      { k: 'CARTONS TODAY', v: c.cartonsReceivedToday },
      { k: 'EXCEPTIONS', v: c.openExceptions, tone: c.openExceptions ? 'err' : undefined },
    ]},
    { key: 'tote', title: 'RECEIVING TOTES', to: '/admin/containers', rows: [
      { k: 'ARTICLES IN TOTES', v: c.articlesAwaitingSorting, tone: c.articlesAwaitingSorting ? 'warn' : undefined },
    ]},
    { key: 'srt', title: 'CATEGORY SORTING', to: '/admin/traceability', rows: [
      { k: 'WAITING', v: c.articlesAwaitingSorting, tone: c.articlesAwaitingSorting ? 'warn' : undefined },
      { k: 'NEEDS_REVIEW', v: null },
    ]},
    { key: 'sto', title: 'STORAGE', to: '/admin/traceability', rows: [
      { k: 'STORED', v: c.articlesStored, tone: 'ok' },
      { k: 'CARTONS WAITING', v: c.awaitingPutaway, tone: c.awaitingPutaway ? 'warn' : undefined },
    ]},
    { key: 'osr', title: 'CUSTOMER ORDER SORTING', to: '/admin/orders', rows: [
      { k: 'OPEN ORDERS', v: c.openOrders },
    ]},
    { key: 'bin', title: 'CUSTOMER BINS', to: '/admin/containers', rows: [
      { k: 'READY FOR PACKING', v: c.binsReadyForPacking, tone: c.binsReadyForPacking ? 'warn' : undefined },
    ]},
    { key: 'pck', title: 'PACKING', to: '/admin/shipments', rows: [
      { k: 'BINS WAITING', v: c.binsReadyForPacking, tone: c.binsReadyForPacking ? 'warn' : undefined },
      { k: 'PACKED (READY)', v: c.shipmentsReadyToShip, tone: c.shipmentsReadyToShip ? 'ok' : undefined },
    ]},
    { key: 'shp', title: 'SHIPPING', to: '/admin/shipments', rows: [
      { k: 'READY', v: c.shipmentsReadyToShip, tone: c.shipmentsReadyToShip ? 'warn' : undefined },
      { k: 'SHIPPED TODAY', v: c.shippedToday, tone: c.shippedToday ? 'ok' : undefined },
    ]},
  ];

  /** C. OPERATIONS panels (§5) — status/current/attention + [OPEN]. */
  const panels: Array<{
    title: string; to: string;
    status: 'RUNNING' | 'IDLE' | 'ATTENTION';
    current: Array<[string, number | null]>;
    attention: number | null;
  }> = [
    { title: 'RECEIVING', to: '/admin/exceptions',
      status: c.openExceptions ? 'ATTENTION' : c.activeSessions ? 'RUNNING' : 'IDLE',
      current: [['sessions', c.activeSessions], ['cartons today', c.cartonsReceivedToday]],
      attention: c.openExceptions },
    { title: 'SORTING', to: '/admin/traceability',
      status: c.articlesAwaitingSorting ? 'ATTENTION' : 'IDLE',
      current: [['waiting', c.articlesAwaitingSorting], ['needs_review', null]],
      attention: null },
    { title: 'STORAGE', to: '/admin/traceability',
      status: c.awaitingPutaway ? 'ATTENTION' : c.activePutawaySessions ? 'RUNNING' : 'IDLE',
      current: [['stored', c.articlesStored], ['waiting cartons', c.awaitingPutaway]],
      attention: c.awaitingPutaway },
    { title: 'ORDER SORTING', to: '/admin/orders',
      status: c.openOrders ? 'RUNNING' : 'IDLE',
      current: [['open orders', c.openOrders]],
      attention: null },
    { title: 'PACKING', to: '/admin/shipments',
      status: c.binsReadyForPacking ? 'ATTENTION' : 'IDLE',
      current: [['bins ready', c.binsReadyForPacking], ['packed today', null]],
      attention: c.binsReadyForPacking },
    { title: 'SHIPPING', to: '/admin/shipments',
      status: c.shipmentsReadyToShip ? 'ATTENTION' : 'IDLE',
      current: [['ready', c.shipmentsReadyToShip], ['shipped today', c.shippedToday]],
      attention: c.shipmentsReadyToShip },
  ];

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Warehouse Control Room</h1>
          <p className="ac-sub">
            Live floor state · {new Date(ov.generatedAt).toLocaleTimeString()} · auto-refresh 30s
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()}>REFRESH</button>
      </header>
      {error && <div className="ac-error">{error}</div>}

      {/* ---- A. WAREHOUSE STATUS ---------------------------------------- */}
      <div className="ac-kpis">
        <Kpi label="Active workers" value={busyWorkerIds.size}
             tone={busyWorkerIds.size ? 'ok' : undefined}
             onClick={() => navigate('/admin/workers')} />
        <Kpi label="Active stations" value={`${c.activeStations}/${c.stations}`}
             onClick={() => navigate('/admin/stations')} />
        <Kpi label="Open exceptions" value={c.openExceptions}
             tone={c.openExceptions ? 'bad' : 'ok'}
             onClick={() => navigate('/admin/exceptions')} />
        <Kpi label="Receiving sessions" value={c.activeSessions}
             tone={c.activeSessions ? 'ok' : undefined} />
        <Kpi label="Putaway sessions" value={c.activePutawaySessions}
             tone={c.activePutawaySessions ? 'ok' : undefined} />
        <Kpi label="Corrections today" value={c.correctionsToday}
             tone={c.correctionsToday ? 'alert' : undefined}
             onClick={() => navigate('/admin/corrections')} />
        <Kpi label="Expected arrivals" value={c.expectedArrivals}
             onClick={() => navigate('/admin/arrivals')} />
      </div>

      {/* ---- B. OPERATION PIPELINE ---------------------------------------- */}
      <section className="os-card" style={{ marginBottom: 14 }}>
        <div className="os-spread">
          <h2 className="os-card-title">Operation pipeline</h2>
          <span className="os-muted mono">INBOUND → STORAGE → OUTBOUND</span>
        </div>
        <div className="ac-pipe">
          {pipeline.map((st, i) => (
            <div key={st.key} className="ac-pipe-stage">
              <button type="button" className="ac-pipe-card" onClick={() => navigate(st.to)}>
                <div className="ac-pipe-title">{st.title}</div>
                {st.rows.map((r) => (
                  <div key={r.k} className="ac-pipe-row">
                    <span className="ac-pipe-k">{r.k}</span>
                    <span className={`ac-pipe-v${r.tone && r.v ? ` is-${r.tone}` : ''}`}>
                      {r.v === null
                        ? <span className="os-muted" title="not aggregated by backend yet">n/a</span>
                        : r.v}
                    </span>
                  </div>
                ))}
              </button>
              {i < pipeline.length - 1 && <div className="ac-pipe-arrow" aria-hidden>→</div>}
            </div>
          ))}
        </div>
      </section>

      {/* ---- C. OPERATIONS PANELS ----------------------------------------- */}
      <section className="os-card" style={{ marginBottom: 14 }}>
        <h2 className="os-card-title">Operations</h2>
        <div className="ac-ops">
          {panels.map((p) => (
            <div key={p.title} className="ac-op">
              <div className="os-spread">
                <span className="ac-op-title">{p.title}</span>
                <span className={`os-tag ${
                  p.status === 'ATTENTION' ? 'os-tag--warn'
                    : p.status === 'RUNNING' ? 'os-tag--ok' : 'os-tag--muted'}`}>
                  {p.status}
                </span>
              </div>
              <div className="ac-op-body">
                {p.current.map(([k, v]) => (
                  <div key={k} className="ac-pipe-row">
                    <span className="ac-pipe-k">{k.toUpperCase()}</span>
                    <span className="ac-pipe-v">
                      {v === null
                        ? <span className="os-muted" title="not aggregated by backend yet">n/a</span>
                        : v}
                    </span>
                  </div>
                ))}
                <div className="ac-pipe-row">
                  <span className="ac-pipe-k">ATTENTION</span>
                  <span className={`ac-pipe-v${p.attention ? ' is-warn' : ''}`}>
                    {p.attention === null ? <span className="os-muted">n/a</span> : p.attention}
                  </span>
                </div>
              </div>
              <button type="button" className="os-btn ac-op-open" onClick={() => navigate(p.to)}>
                [ OPEN ]
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ---- D. WORKERS + STATIONS ---------------------------------------- */}
      <div className="ac-2col">
        <section className="os-card">
          <div className="os-spread">
            <h2 className="os-card-title">Workers</h2>
            <button className="ac-linkbtn" onClick={() => navigate('/admin/workers')}>all workers</button>
          </div>
          {!workers ? <div className="os-empty">loading…</div> : (
            <div className="ac-scroll">
              <table className="os-table">
                <thead>
                  <tr><th>Worker</th><th>Role</th><th>Current task</th><th>Station</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {workers.map((w) => {
                    const busy = busyWorkerIds.has(w.id);
                    return (
                      <tr key={w.id} className="is-click" onClick={() => navigate(`/admin/workers/${w.id}`)}>
                        <td>{w.name} <span className="os-muted mono">{w.employeeCode}</span></td>
                        <td className="os-muted">{w.roles[0] ?? '—'}</td>
                        <td>{taskByWorker.get(w.id)
                          ?? <span className="os-muted">—</span>}</td>
                        <td>{w.station
                          ? <span className="os-tag os-tag--info">{w.station.code}</span>
                          : <span className="os-muted">—</span>}</td>
                        <td>
                          <span className={`os-tag ${busy ? 'os-tag--ok' : 'os-tag--muted'}`}>
                            {busy ? 'ACTIVE' : 'IDLE'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {workers.length === 0 && (
                    <tr><td colSpan={5} className="os-empty">No active workers.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="os-card">
          <div className="os-spread">
            <h2 className="os-card-title">Stations</h2>
            <button className="ac-linkbtn" onClick={() => navigate('/admin/stations')}>manage</button>
          </div>
          <table className="os-table">
            <thead>
              <tr><th>Station</th><th>Type</th><th>Worker</th><th>Current task</th><th>Status</th></tr>
            </thead>
            <tbody>
              {ov.stations.map((s) => {
                const tone = stationTone(s.status, !!s.worker);
                const task = s.worker ? taskByWorker.get(s.worker.id) : undefined;
                return (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td className="os-muted">{s.department}</td>
                    <td>{s.worker?.name ?? <span className="os-muted">—</span>}</td>
                    <td>{task ?? <span className="os-muted">—</span>}</td>
                    <td><span className={`os-tag ${tone.cls}`}>{tone.label}</span></td>
                  </tr>
                );
              })}
              {ov.stations.length === 0 && (
                <tr><td colSpan={5} className="os-empty">No stations configured.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {/* ---- E. EXCEPTIONS + F. LIVE ACTIVITY ------------------------------ */}
      <div className="ac-2col" style={{ marginTop: 14 }}>
        <section className="os-card">
          <div className="os-spread">
            <h2 className="os-card-title">Open exceptions</h2>
            <span className="os-muted mono">
              CRIT {sevCounts.CRITICAL} · HIGH {sevCounts.HIGH} · MED {sevCounts.MEDIUM} · LOW {sevCounts.LOW}
            </span>
          </div>
          {!exceptions ? <div className="os-empty">loading…</div>
            : sortedExceptions.length === 0 ? (
              <div className="os-empty">No open exceptions. Floor is clean.</div>
            ) : (
              <div className="ac-scroll">
                <table className="os-table">
                  <thead>
                    <tr><th>Sev.</th><th>Type</th><th>Session</th><th>Worker</th><th>Raised</th><th /></tr>
                  </thead>
                  <tbody>
                    {sortedExceptions.slice(0, 8).map((x) => {
                      const sev = severityOf(x.type);
                      return (
                        <tr key={x.id}>
                          <td><span className={`os-tag ${SEV_TAG[sev]}`}>{sev}</span></td>
                          <td>{x.type.replace(/_/g, ' ')}</td>
                          <td className="mono">{x.session?.code ?? '—'}</td>
                          <td className="os-muted">{x.worker?.name ?? '—'}</td>
                          <td className="os-muted">{since(x.createdAt)}</td>
                          <td>
                            <button className="ac-linkbtn" onClick={() => navigate('/admin/exceptions')}>
                              open
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {sortedExceptions.length > 8 && (
                  <button className="ac-linkbtn" style={{ marginTop: 8 }}
                          onClick={() => navigate('/admin/exceptions')}>
                    view all {sortedExceptions.length} exceptions →
                  </button>
                )}
              </div>
            )}
        </section>

        <section className="os-card">
          <div className="os-spread">
            <h2 className="os-card-title">Live activity</h2>
            <button className="ac-linkbtn" onClick={() => navigate('/admin/activity')}>full stream</button>
          </div>
          {activityDenied ? (
            <div className="os-empty">Requires the audit.view permission.</div>
          ) : !activity ? <div className="os-empty">loading…</div>
            : activity.length === 0 ? <div className="os-empty">No recorded events.</div> : (
              <div className="ac-scroll">
                <div className="ac-feed">
                  {activity.slice(0, 12).map((e) => (
                    <div key={e.id} className="ac-feed-row">
                      <span className="ac-feed-time mono">{since(e.createdAt)}</span>
                      <span className="ac-feed-event">{e.action.replace(/_/g, ' ')}</span>
                      <span className="os-muted">{e.actor?.name ?? 'system'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </section>
      </div>
    </>
  );
}

function Kpi({ label, value, tone, onClick }: {
  label: string; value: number | string;
  tone?: 'ok' | 'bad' | 'alert'; onClick?: () => void;
}) {
  return (
    <div
      className={`ac-kpi${tone ? ` ac-kpi--${tone}` : ''}${onClick ? ' is-click' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
    >
      <div className="ac-kpi-value">{value}</div>
      <div className="ac-kpi-label">{label}</div>
    </div>
  );
}
