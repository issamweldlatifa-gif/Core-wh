import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, type OpsOverview } from '../api';

/**
 * OPERATIONS — the running work on the floor, live (Admin CC V1 §5).
 * Active receiving + putaway sessions with drill-down; per-area counters.
 * One aggregate request, 30 s polling.
 */
export default function Operations() {
  const [ov, setOv] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setOv(await adminApi.overview());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Failed to load operations.');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (error && !ov) return <div className="ac-error">{error}</div>;
  if (!ov) return <div className="os-empty">loading operations…</div>;
  const c = ov.counters;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Operations</h1>
          <p className="ac-sub">Running sessions and per-area load · auto-refresh 30s</p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()}>REFRESH</button>
      </header>
      {error && <div className="ac-error">{error}</div>}

      <div className="ac-kpis">
        <Chip label="Receiving sessions" v={c.activeSessions} />
        <Chip label="Putaway sessions" v={c.activePutawaySessions} />
        <Chip label="Articles awaiting sorting" v={c.articlesAwaitingSorting} warn />
        <Chip label="Cartons awaiting putaway" v={c.awaitingPutaway} warn />
        <Chip label="Open orders" v={c.openOrders} />
        <Chip label="Bins ready for packing" v={c.binsReadyForPacking} warn />
        <Chip label="Ready to ship" v={c.shipmentsReadyToShip} warn />
        <Chip label="Shipped today" v={c.shippedToday} />
      </div>

      <div className="ac-2col">
        <section className="os-card">
          <h2 className="os-card-title">Active receiving sessions</h2>
          {ov.activeSessions.length === 0 ? (
            <div className="os-empty">No receiving session in progress.</div>
          ) : (
            <table className="os-table">
              <thead>
                <tr><th>Session</th><th>Worker</th><th>Arrival</th><th>Cartons</th><th>Exc.</th><th /></tr>
              </thead>
              <tbody>
                {ov.activeSessions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>{s.worker?.name ?? '—'}</td>
                    <td>{s.arrival?.code ?? '—'}</td>
                    <td>{s.cartonEvents}</td>
                    <td>{s.discrepancies > 0
                      ? <span className="os-tag os-tag--err">{s.discrepancies}</span>
                      : <span className="os-muted">0</span>}</td>
                    <td>
                      <button className="ac-linkbtn" onClick={() => navigate(`/admin/sessions/${s.id}`)}>
                        open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="os-card">
          <h2 className="os-card-title">Active putaway sessions</h2>
          {ov.putawaySessions.length === 0 ? (
            <div className="os-empty">No stowing in progress.</div>
          ) : (
            <table className="os-table">
              <thead>
                <tr><th>Session</th><th>Worker</th><th>Station</th><th>Placements</th><th>Status</th></tr>
              </thead>
              <tbody>
                {ov.putawaySessions.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.code}</td>
                    <td>{p.worker?.name ?? '—'}</td>
                    <td className="os-muted">{p.stationCode ?? '—'}</td>
                    <td>{p.placements}</td>
                    <td>
                      <span className={`os-tag ${p.status === 'ACTIVE' ? 'os-tag--ok' : 'os-tag--warn'}`}>
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

function Chip({ label, v, warn }: { label: string; v: number; warn?: boolean }) {
  return (
    <div className={`ac-kpi${warn && v ? ' ac-kpi--alert' : v ? ' ac-kpi--ok' : ''}`}>
      <div className="ac-kpi-value">{v}</div>
      <div className="ac-kpi-label">{label}</div>
    </div>
  );
}
