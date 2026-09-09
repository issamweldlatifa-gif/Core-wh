import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { tsAdminApi, type TsOverview, type TsReportDetail, type TsReportRow } from '../temp-storage';
import { useAsync } from './useAsync';

/**
 * Temporary Storage — Admin view (extends the existing Control Center;
 * it is NOT a parallel dashboard).
 *
 * Shows: stations/sections/containers, capacity (runtime configuration),
 * stored/remaining, the open Review lane and the Rapports de Fin
 * (Admin → Reports: review/close), all from the real workflow endpoints.
 */

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'muted' | 'err'> = {
  SUBMITTED: 'warn',
  REVIEWED: 'ok',
  CLOSED: 'muted',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function TemporaryStorageAdmin() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stations.manage');
  const [note, setNote] = useState('');

  const overview = useAsync(() => tsAdminApi.overview().catch(() => null as TsOverview | null), []);
  const [filter, setFilter] = useState('');
  const reports = useAsync(() => tsAdminApi.reports(filter || undefined), [filter]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useAsync(
    () => (selectedId ? tsAdminApi.report(selectedId) : Promise.resolve(null as TsReportDetail | null)),
    [selectedId],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cfg = overview.data?.capacity ?? 20;
  const [capacity, setCapacity] = useState<number | null>(null);

  async function saveCapacity() {
    setBusy(true); setErr(null);
    try {
      await tsAdminApi.setConfig(capacity ?? cfg);
      setCapacity(null);
      await overview.reload();
    } catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
  }

  async function act(fn: () => Promise<unknown>, reload: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); await reload(); }
    catch (e) { setErr(apiErrorMessage(e)); } finally { setBusy(false); }
  }

  const openReport = (r: TsReportRow) => { setSelectedId(r.id); setNote(''); };

  const ov = overview.data;
  const totals = (ov?.stations ?? []).reduce(
    (a, s) => ({
      containers: a.containers + s.containers,
      stored: a.stored + s.stored,
      capacity: a.capacity + s.capacity,
      review: a.review + s.reviewItems,
    }),
    { containers: 0, stored: 0, capacity: 0, review: 0 },
  );

  return (
    <div style={{ padding: '22px 24px', maxWidth: 1240 }}>
      <div className="cc-head">
        <h1 className="ac-title">Temporary Storage</h1>
        <p className="ac-sub os-muted">
          Sections · containers · capacity — CONFIRMED products only, real workflow data. Cartons never enter here.
        </p>
      </div>

      {overview.loading && <div className="os-empty">Loading overview…</div>}
      {overview.error && <div className="ac-error">{overview.error}</div>}
      {ov && (
        <>
          <div className="os-row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <div className="os-card" style={{ padding: '10px 16px' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{totals.containers}</div>
              <div className="os-muted">CONTAINERS</div>
            </div>
            <div className="os-card" style={{ padding: '10px 16px' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--success)' }}>{totals.stored}<span className="os-muted">/{totals.capacity}</span></div>
              <div className="os-muted">STORED / CAPACITY</div>
            </div>
            <div className="os-card" style={{ padding: '10px 16px' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{Math.max(0, totals.capacity - totals.stored)}</div>
              <div className="os-muted">SPACE LEFT</div>
            </div>
            <div className="os-card" style={{ padding: '10px 16px' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--error)' }}>{totals.review}</div>
              <div className="os-muted">IN REVIEW</div>
            </div>
            <div className="os-card" style={{ padding: '10px 16px' }}>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--warning)' }}>{ov.openMovesWaiting}</div>
              <div className="os-muted">MOVES WAITING</div>
            </div>
            {/* Capacity = runtime configuration (backend SystemSetting), not code. */}
            <div className="os-card" style={{ padding: '10px 16px' }}>
              <div className="os-row" style={{ gap: 8 }}>
                <label className="os-label" htmlFor="ts-capacity">CONTAINER CAPACITY</label>
                <input
                  id="ts-capacity"
                  type="number"
                  min={1}
                  max={500}
                  className="os-input"
                  style={{ width: 90 }}
                  value={capacity ?? cfg}
                  onChange={(e) => setCapacity(Number(e.target.value))}
                  disabled={!canManage}
                />
                {canManage && (
                  <button type="button" className="os-btn" disabled={busy || capacity === null || capacity === cfg} onClick={() => void saveCapacity()}>
                    SAVE
                  </button>
                )}
              </div>
            </div>
          </div>

          <h2 className="os-card-title">STATIONS · SECTIONS</h2>
          {(ov.stations.length === 0) && <div className="os-empty">No Temporary Storage station has containers yet.</div>}
          <div className="os-row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch', marginBottom: 18 }}>
            {ov.stations.map((s) => (
              <div key={s.station.id} className="os-card" style={{ padding: '12px 16px', minWidth: 260 }}>
                <div style={{ fontWeight: 800 }}>{s.station.code} <span className="os-tag os-tag--muted">{s.station.status}</span></div>
                <div className="os-muted" style={{ margin: '2px 0 8px' }}>{s.station.name}</div>
                <div className="os-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {s.sections.map((l) => <span key={l} className="os-tag os-tag--info">{l}</span>)}
                  {s.sections.length === 0 && <span className="os-muted">—</span>}
                </div>
                <div className="os-muted" style={{ marginTop: 8, fontSize: '0.78rem' }}>
                  {s.containers} containers · <b>{s.stored}</b>/{s.capacity} stored · {s.remaining} free
                  {s.reviewItems > 0 && <span style={{ color: 'var(--error)' }}> · {s.reviewItems} REVIEW</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {ov && ov.reviewItems.length > 0 && (
        <div className="os-card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
          <h2 className="os-card-title" style={{ padding: '12px 16px 0' }}>REVIEW LANE ({ov.reviewItems.length}) — resolved from the Exceptions board</h2>
          <table className="os-table">
            <thead>
              <tr>
                <th>Product</th><th>Customer</th><th>Section</th><th>Reason</th><th>Scanned</th><th>By</th>
              </tr>
            </thead>
            <tbody>
              {ov.reviewItems.map((r) => (
                <tr key={r.id}>
                  <td>{r.productName ?? r.reference ?? r.sku ?? '—'}</td>
                  <td>{r.customerName ?? '—'}</td>
                  <td><span className="os-tag os-tag--info">{r.section ?? '—'}</span></td>
                  <td className="os-muted">{r.reason ?? '—'}</td>
                  <td className="os-muted">{fmt(r.scannedAt)}</td>
                  <td className="os-muted">{r.scannedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="os-card-title">RAPPORTS DE FIN — Admin → Reports</h2>
      {err && <div className="ac-error">{err}</div>}
      <div className="os-row" style={{ gap: 6, marginBottom: 10 }}>
        {['', 'SUBMITTED', 'REVIEWED', 'CLOSED'].map((s) => (
          <button key={s || 'ALL'} type="button" className="os-btn" onClick={() => { setFilter(s); setSelectedId(null); }}>
            {s || 'ALL'}
          </button>
        ))}
      </div>

      {reports.loading && <div className="os-empty">Loading reports…</div>}
      {reports.data && reports.data.length === 0 && <div className="os-empty">No Rapport de Fin yet.</div>}
      {reports.data && reports.data.length > 0 && (
        <div className="os-card" style={{ padding: 0, overflow: 'hidden', marginBottom: 18 }}>
          <table className="os-table">
            <thead>
              <tr>
                <th>Station</th><th>Worker</th><th>Status</th><th>Received</th><th>Stored</th><th>Review</th><th>Containers</th><th>Exceptions</th><th>Submitted</th><th />
              </tr>
            </thead>
            <tbody>
              {reports.data.map((r) => (
                <tr key={r.id} style={selectedId === r.id ? { background: 'rgba(0,255,136,0.06)' } : undefined}>
                  <td>{r.stationCode}</td>
                  <td>{r.workerName}</td>
                  <td><span className={`os-tag os-tag--${STATUS_TONE[r.status] ?? 'muted'}`}>{r.status}</span></td>
                  <td>{r.totals.productsReceived}</td>
                  <td>{r.totals.productsStored}</td>
                  <td>{r.totals.productsInReview}</td>
                  <td>{r.totals.containersUsed}</td>
                  <td>{r.totals.exceptions}</td>
                  <td className="os-muted">{fmt(r.submittedAt)}</td>
                  <td><button type="button" className="os-btn" onClick={() => openReport(r)}>{selectedId === r.id ? 'OPEN' : 'DETAIL'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail.loading && <div className="os-empty">Loading report…</div>}
      {detail.error && <div className="ac-error">{detail.error}</div>}
      {detail.data && (
        <div className="os-card" style={{ padding: '14px 18px', marginBottom: 24 }}>
          <div className="os-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>
              Rapport de Fin — {detail.data.stationCode}
              <span className={`os-tag os-tag--${STATUS_TONE[detail.data.status] ?? 'muted'}`} style={{ marginLeft: 10 }}>{detail.data.status}</span>
            </h3>
            <span className="os-muted">Worker: {detail.data.workerName} · Station: {detail.data.stationCode} · {fmt(detail.data.submittedAt)}</span>
          </div>
          {detail.data.deviceName && <div className="os-muted">Device: {detail.data.deviceType ?? ''} {detail.data.deviceName}</div>}
          <div className="os-row" style={{ gap: 14, flexWrap: 'wrap', margin: '10px 0' }}>
            {[
              ['RECEIVED', detail.data.totals.productsReceived],
              ['STORED', detail.data.totals.productsStored],
              ['IN REVIEW', detail.data.totals.productsInReview],
              ['CONTAINERS USED', detail.data.totals.containersUsed],
              ['EXCEPTIONS', detail.data.totals.exceptions],
            ].map(([k, v]) => (
              <span key={k as string}><b>{v}</b> <span className="os-muted">{k}</span></span>
            ))}
          </div>
          <div className="os-row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(detail.data.sectionsProcessed ?? []).map((s) => <span key={s} className="os-tag os-tag--info">{s}</span>)}
            {(detail.data.sectionsProcessed ?? []).length === 0 && <span className="os-muted">No sections recorded</span>}
          </div>
          {detail.data.observation && <p className="os-muted" style={{ margin: '8px 0 0' }}>Obs.: {detail.data.observation}</p>}
          {detail.data.reviewNote && <p className="os-muted">Review note: {detail.data.reviewNote}</p>}
          <div className="os-muted" style={{ marginTop: 6, fontSize: '0.78rem' }}>
            Started {fmt(detail.data.startedAt)} · Submitted {fmt(detail.data.submittedAt)} · Reviewed {fmt(detail.data.reviewedAt)} · Closed {fmt(detail.data.closedAt)}
          </div>

          {canManage && (detail.data.status === 'SUBMITTED' || detail.data.status === 'REVIEWED') && (
            <div className="os-row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {detail.data.status === 'SUBMITTED' && (
                <>
                  <input
                    className="os-input"
                    style={{ flex: '1 1 240px' }}
                    placeholder="Review note (optional)"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button
                    type="button"
                    className="os-btn os-btn--primary"
                    disabled={busy}
                    onClick={() => void act(() => tsAdminApi.reviewReport(detail.data!.id, note.trim() || undefined), async () => { await detail.reload(); await reports.reload(); setNote(''); })}
                  >
                    REVIEW
                  </button>
                </>
              )}
              <button
                type="button"
                className="os-btn"
                disabled={busy}
                onClick={() => void act(() => tsAdminApi.closeReport(detail.data!.id), async () => { await detail.reload(); await reports.reload(); })}
              >
                CLOSE
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
