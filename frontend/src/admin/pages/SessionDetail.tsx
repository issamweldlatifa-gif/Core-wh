import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi, type SessionDetail as Detail } from '../api';
import { useAsync } from './useAsync';
import CorrectionDialog from './CorrectionDialog';
import { useAuth } from '../../context/AuthContext';
import { LoadingState, StatusBadge, Button } from '../../ui';

/**
 * Session drill-down (§37) with the authorised correction actions (§7/§39).
 * Everything here is read-only except the explicit, audited corrections.
 */
export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const { data, loading, error, reload } = useAsync(() => adminApi.session(id), [id]);
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const canCorrect = hasPermission('operations.correct');

  const [reverse, setReverse] = useState<Detail['cartons'][number] | null>(null);
  const [qty, setQty] = useState<Detail['products'][number] | null>(null);
  const [qtyValue, setQtyValue] = useState('0');
  const [reopen, setReopen] = useState(false);

  if (loading && !data) return <LoadingState label="Loading session…" block />;
  if (error) return <div className="ac-error">{error}</div>;
  if (!data) return null;

  const s = data.session;
  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Session {s.code}</h1>
          <p className="ac-sub">
            {s.worker?.name ?? 'unknown worker'} · {s.arrival?.code ?? '—'} ·{' '}
            {new Date(s.startedAt).toLocaleString()} · {s.deviceType ?? 'device n/a'}
            {s.station ? ` · ${s.station.code}` : ''}
          </p>
        </div>
        <div className="os-row">
          {canCorrect && s.status !== 'RECEIVING' && (
            <Button icon="wrench" onClick={() => setReopen(true)}>Reopen</Button>
          )}
          <Button icon="back" onClick={() => navigate(-1)}>Back</Button>
        </div>
      </header>

      <div className="ac-2col">
        <section className="os-card">
          <h2 className="os-card-title">Operational timeline</h2>
          <div className="ac-timeline">
            {data.timeline.map((e, i) => (
              <div className="ac-tl-item" key={i}>
                <span className="ac-tl-time">
                  {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="ac-tl-kind" data-k={e.kind}>{e.kind.replace(/_/g, ' ')}</span>
                <span>{e.label}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="ac-panels">
          <section className="os-card">
            <h2 className="os-card-title">Cartons</h2>
            <table className="os-table">
              <thead><tr><th>Code</th><th>Source</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.cartons.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.scannedCode}</td>
                    <td className="os-muted">{c.source}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>
                      {canCorrect && c.status === 'RECEIVED' && (
                        <button className="ac-linkbtn" onClick={() => setReverse(c)}>reverse</button>
                      )}
                    </td>
                  </tr>
                ))}
                {data.cartons.length === 0 && <tr><td colSpan={4} className="os-empty">No carton events.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Products</h2>
            <table className="os-table">
              <thead><tr><th>SKU</th><th>Recv/Exp</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.sku ?? '—'}</td>
                    <td>{p.receivedQuantity}/{p.expectedQuantity}</td>
                    <td><StatusBadge status={p.status} /></td>
                    <td>
                      {canCorrect && (
                        <button
                          className="ac-linkbtn"
                          onClick={() => { setQty(p); setQtyValue(String(p.receivedQuantity)); }}
                        >
                          correct
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {data.products.length === 0 && <tr><td colSpan={4} className="os-empty">No product lines.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Corrections on this session</h2>
            {data.corrections.length === 0 ? (
              <div className="os-empty">None.</div>
            ) : data.corrections.map((c) => (
              <div key={c.id} className="ac-tl-item">
                <span className="ac-tl-time">{new Date(c.createdAt).toLocaleTimeString()}</span>
                <span className="ac-tl-kind" data-k="CORRECTION">{c.code}</span>
                <span>{c.action.replace(/_/g, ' ')} — {c.reason} <em className="os-muted">by {c.admin?.name}</em></span>
              </div>
            ))}
          </section>
        </div>
      </div>

      {reverse && (
        <CorrectionDialog
          title={`Reverse carton ${reverse.scannedCode}`}
          description="The receipt event is kept and marked REVERSED; the carton returns to EXPECTED."
          original={reverse}
          confirmLabel="Reverse receiving"
          onConfirm={async (reason) => { await adminApi.reverseCarton(reverse.id, reason); await reload(); }}
          onClose={() => setReverse(null)}
        />
      )}

      {qty && (
        <CorrectionDialog
          title={`Correct quantity for ${qty.sku ?? 'product'}`}
          description="Sets a new received quantity. The previous value is preserved in the correction record."
          original={qty}
          extra={{ label: 'New received quantity', value: qtyValue, onChange: setQtyValue, type: 'number' }}
          confirmLabel="Correct quantity"
          onConfirm={async (reason) => {
            await adminApi.correctQuantity(qty.id, Number(qtyValue), reason);
            await reload();
          }}
          onClose={() => setQty(null)}
        />
      )}

      {reopen && (
        <CorrectionDialog
          title={`Reopen session ${s.code}`}
          description="Reopens a closed session so receiving can continue."
          original={{ code: s.code, status: s.status, completedAt: s.completedAt }}
          confirmLabel="Reopen session"
          onConfirm={async (reason) => { await adminApi.reopenSession(s.id, reason); await reload(); }}
          onClose={() => setReopen(false)}
        />
      )}
    </>
  );
}
