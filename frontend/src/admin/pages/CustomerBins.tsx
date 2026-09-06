import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, type ContainerBoardRow } from '../api';
import { useAuth } from '../../context/AuthContext';
import CorrectionDialog from './CorrectionDialog';

/**
 * CUSTOMER BINS (COMMAND #1 FINAL §12) — per-order operational containers.
 * Article count is live; expected count is the units requested on the
 * linked order. Sorting worker derives from the ITEM_PICKED audit trail.
 *
 * Master Order §15: a completed bin is LOCKED (READY_FOR_PACKING + customer
 * QR). The ONLY way back is the audited admin correction REOPEN_CUSTOMER_BIN
 * — the "reopen" action below, which reuses the standard correction dialog
 * (mandatory reason, original state shown, history preserved).
 */
export default function CustomerBins() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canCorrect = hasPermission('operations.correct');
  const [rows, setRows] = useState<ContainerBoardRow[] | null>(null);
  const [filter, setFilter] = useState('ALL'); // ALL | ACTIVE | READY_FOR_PACKING | PACKED | CLOSED
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<ContainerBoardRow | null>(null);

  async function load() {
    setBusy(true);
    try {
      setRows(await adminApi.customerBins());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load customer bins.');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    if (!rows) return null;
    if (filter === 'ALL') return rows;
    return rows.filter((c) => c.status === filter);
  }, [rows, filter]);

  const counts = useMemo(() => {
    if (!rows) return null;
    const pick = (s: string) => rows.filter((c) => c.status === s).length;
    return { ALL: rows.length, ACTIVE: pick('ACTIVE'), READY_FOR_PACKING: pick('READY_FOR_PACKING'), PACKED: pick('PACKED'), CLOSED: pick('CLOSED') };
  }, [rows]);

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Customer Bins</h1>
          <p className="ac-sub">
            Article → Customer → Order → Bin · expected vs present counts are live ·
            order completeness is decided by the backend, never the UI.
            A locked bin can only be reopened through an audited admin correction (S15).
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()} disabled={busy}>
          {busy ? '…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}

      <section className="os-card">
        <div className="cc-head">
          <div className="os-row" style={{ flexWrap: 'wrap' }}>
            {(['ALL', 'ACTIVE', 'READY_FOR_PACKING', 'PACKED', 'CLOSED'] as const).map((f) => (
              <button key={f} className={`os-btn${filter === f ? ' os-btn--primary' : ''}`} onClick={() => setFilter(f)}>
                {f.replace(/_/g, ' ')} {counts ? `(${counts[f]})` : ''}
              </button>
            ))}
          </div>
        </div>

        {!rows ? (
          <div className="os-empty">loading bins…</div>
        ) : !visible || visible.length === 0 ? (
          <div className="os-empty">No customer bins match.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr><th>Bin</th><th>Customer</th><th>Order</th><th>Articles</th><th>Expected</th><th>Status</th><th>Worker</th><th>Created</th><th /></tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.code}</td>
                    <td className="mono">{c.label ?? c.order?.customer ?? '—'}</td>
                    <td className="mono">{c.order?.reference ?? '—'}</td>
                    <td className="mono">{c.count}</td>
                    <td className="mono">{c.expected ?? <span className="os-muted">—</span>}</td>
                    <td>
                      {c.status === 'READY_FOR_PACKING'
                        ? <span className="os-tag os-tag--warn">READY FOR PACKING</span>
                        : c.status === 'PACKED'
                          ? <span className="os-tag os-tag--ok">PACKED</span>
                          : c.status === 'CLOSED'
                            ? <span className="os-tag os-tag--muted">CLOSED</span>
                            : <span className="os-tag os-tag--ok">OPEN</span>}
                    </td>
                    <td>{c.worker?.name ?? <span className="os-muted">—</span>}</td>
                    <td className="os-muted">{new Date(c.createdAt).toLocaleString()}</td>
                    <td>
                      <span className="os-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <button className="ac-linkbtn mono" onClick={() => navigate(`/admin/containers/${c.code}`)}>
                          details
                        </button>
                        {canCorrect && c.dbStatus === 'READY_FOR_PACKING' && (
                          <button className="ac-linkbtn mono" onClick={() => setReopenTarget(c)}>
                            reopen…
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {reopenTarget && (
        <CorrectionDialog
          title={`Reopen customer bin ${reopenTarget.code}`}
          description="The bin returns to ACTIVE and its customer QR is cleared; the completeness check re-runs and a new QR is generated when the order is complete again. A worker can never do this — only this audited admin correction."
          original={{
            bin: reopenTarget.code,
            status: reopenTarget.status,
            order: reopenTarget.order?.reference ?? null,
            articles: reopenTarget.count,
          }}
          confirmLabel="Reopen bin"
          onConfirm={async (reason) => {
            await adminApi.reopenCustomerBin(reopenTarget.code, reason);
            await load();
          }}
          onClose={() => setReopenTarget(null)}
        />
      )}
    </>
  );
}
