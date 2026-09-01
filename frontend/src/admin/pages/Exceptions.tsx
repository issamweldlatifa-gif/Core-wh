import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi, type ExceptionRow } from '../api';
import { useAsync } from './useAsync';
import CorrectionDialog from './CorrectionDialog';
import { useAuth } from '../../context/AuthContext';

/** Exception Center (§38) with an authorised, audited resolution path (§39). */
export default function Exceptions() {
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED' | 'ALL'>('OPEN');
  const { data, loading, error, reload } = useAsync(() => adminApi.exceptions(status), [status]);
  const [target, setTarget] = useState<ExceptionRow | null>(null);
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const canCorrect = hasPermission('operations.correct');

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Exception Center</h1>
          <p className="ac-sub">Unknown products, duplicates, mismatches and quantity exceptions.</p>
        </div>
        <div className="os-row">
          {(['OPEN', 'RESOLVED', 'ALL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`os-btn${status === s ? ' os-btn--primary' : ''}`}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="ac-error">{error}</div>}

      <section className="os-card">
        {loading && !data ? (
          <div className="os-empty">loading exceptions…</div>
        ) : !data || data.length === 0 ? (
          <div className="os-empty">No {status.toLowerCase()} exceptions.</div>
        ) : (
          <table className="os-table">
            <thead>
              <tr>
                <th>Type</th><th>Session</th><th>Worker</th><th>Detail</th>
                <th>Raised</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {data.map((x) => (
                <tr key={x.id}>
                  <td><span className="os-tag os-tag--err">{x.type.replace(/_/g, ' ')}</span></td>
                  <td>
                    {x.session ? (
                      <button className="ac-linkbtn mono" onClick={() => navigate(`/admin/sessions/${x.session!.id}`)}>
                        {x.session.code}
                      </button>
                    ) : '—'}
                  </td>
                  <td>{x.worker?.name ?? '—'}</td>
                  <td className="os-muted">
                    {x.reason ?? (x.expectedQuantity != null
                      ? `expected ${x.expectedQuantity}, actual ${x.actualQuantity}`
                      : '—')}
                  </td>
                  <td className="os-muted">{new Date(x.createdAt).toLocaleString()}</td>
                  <td>
                    <span className={`os-tag ${x.status === 'OPEN' ? 'os-tag--warn' : 'os-tag--ok'}`}>
                      {x.status}
                    </span>
                  </td>
                  <td>
                    {x.status === 'OPEN' && canCorrect && (
                      <button className="ac-linkbtn" onClick={() => setTarget(x)}>resolve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {target && (
        <CorrectionDialog
          title={`Resolve ${target.type.replace(/_/g, ' ')}`}
          description="Resolving records an audited correction; the exception and its history remain visible."
          original={{
            id: target.id, type: target.type, status: target.status,
            expected: target.expectedQuantity, actual: target.actualQuantity,
            session: target.session?.code, worker: target.worker?.name,
          }}
          confirmLabel="Resolve exception"
          onConfirm={async (reason) => {
            await adminApi.resolveException(target.id, reason);
            await reload();
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}
