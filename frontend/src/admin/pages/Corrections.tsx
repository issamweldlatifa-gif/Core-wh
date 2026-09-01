import { Fragment, useState } from 'react';
import { adminApi } from '../api';
import { useAsync } from './useAsync';
import { EmptyState, LoadingState } from '../../ui';

/**
 * Correction ledger (§8/§40).
 * Append-only: every entry shows who, why, when and the exact before/after
 * snapshots. Nothing here can be edited or deleted.
 */
export default function Corrections() {
  const { data, loading, error } = useAsync(() => adminApi.corrections(), []);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <header className="ac-head">
        <h1 className="ac-title">Corrections</h1>
        <p className="ac-sub">Append-only ledger of authorised corrections. History is never overwritten.</p>
      </header>
      {error && <div className="ac-error">{error}</div>}

      <section className="os-card">
        {loading && !data ? <LoadingState /> :
          !data || data.length === 0 ? (
            <EmptyState icon="wrench" title="No corrections recorded" hint="Authorised corrections and their before/after snapshots appear here." />
          ) : (
          <table className="os-table">
            <thead>
              <tr><th>Code</th><th>Action</th><th>Target</th><th>Reason</th><th>Admin</th><th>When</th><th /></tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td className="mono">{c.code}</td>
                    <td><span className="os-tag os-tag--warn">{c.action.replace(/_/g, ' ')}</span></td>
                    <td className="os-muted">{c.entityType.replace(/_/g, ' ')}</td>
                    <td>{c.reason}</td>
                    <td>{c.admin?.name ?? '—'}</td>
                    <td className="os-muted">{new Date(c.createdAt).toLocaleString()}</td>
                    <td>
                      <button className="ac-linkbtn" onClick={() => setOpen(open === c.id ? null : c.id)}>
                        {open === c.id ? 'hide' : 'snapshots'}
                      </button>
                    </td>
                  </tr>
                  {open === c.id && (
                    <tr>
                      <td colSpan={7}>
                        <div className="ac-2col">
                          <div>
                            <span className="os-label">Original</span>
                            <div className="ac-snapshot">{JSON.stringify(c.originalSnapshot, null, 2)}</div>
                          </div>
                          <div>
                            <span className="os-label">After correction</span>
                            <div className="ac-snapshot">{JSON.stringify(c.newSnapshot, null, 2)}</div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
