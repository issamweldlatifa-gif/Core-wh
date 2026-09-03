import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type DataControlHit, type DataControlKind, type DataControlVoidedRow } from '../api';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';

/**
 * ADMIN DATA CONTROL (COMMAND #2) — soft-void only.
 *
 * Search finds any operational record by human/barcode code (WAR/CTN/RCN/BIN/
 * ART/ORD). When the same code was scanned twice, every record appears so the
 * exact wrong one can be voided. Voiding NEVER deletes: the record moves to a
 * terminal VOIDED/CANCELLED state, cleared pointers keep live counts honest,
 * and an audit row names the admin + reason. Viewing requires operations.view;
 * the void action itself is additionally gated by operations.correct (admin).
 */
const KIND_META: Record<DataControlKind, { prefix: string; title: string }> = {
  arrival: { prefix: 'WAR', title: 'Arrival card' },
  carton: { prefix: 'CTN', title: 'Carton' },
  container: { prefix: 'RCN', title: 'Container / tote' },
  article: { prefix: 'ART', title: 'Article' },
  order: { prefix: 'ORD', title: 'Order' },
};

const TERMINAL = new Set(['VOIDED', 'CANCELLED', 'CLOSED', 'PACKED', 'SHIPPED']);

function tone(status: string): string {
  if (TERMINAL.has(status)) return 'os-tag--muted';
  if (['FLAGGED', 'ATTENTION', 'RECEIVED_WITH_DISCREPANCY', 'WRONG_SHIPMENT', 'PAUSED'].includes(status)) return 'os-tag--warn';
  if (['OPEN', 'ACTIVE', 'EXPECTED', 'READY_FOR_PACKING', 'IN_CUSTOMER_BIN', 'IN_CONTAINER'].includes(status)) return 'os-tag--ok';
  if (['RECEIVED', 'RECEIVING', 'STORED'].includes(status)) return 'os-tag--info';
  return '';
}

export default function DataControl() {
  const { hasPermission } = useAuth();
  const canCorrect = hasPermission('operations.correct');

  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DataControlHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [voidLog, setVoidLog] = useState<DataControlVoidedRow[] | null>(null);
  const [target, setTarget] = useState<DataControlHit | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLog = useCallback(async () => {
    try {
      setVoidLog(await adminApi.dataControlVoided());
    } catch (e) {
      // Log is auxiliary; don't block the page on it.
      setVoidLog([]);
    }
  }, []);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  useEffect(() => {
    const term = q.trim();
    if (timer.current) clearTimeout(timer.current);
    if (term.length < 2) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        setHits(await adminApi.dataControlSearch(term));
        setError(null);
      } catch (e) {
        setError(apiErrorMessage(e));
        setHits(null);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  const counts = (() => {
    if (!hits) return null;
    const c: Record<string, number> = {};
    for (const h of hits) c[h.kind] = (c[h.kind] ?? 0) + 1;
    return c;
  })();

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Data Control</h1>
          <p className="ac-sub">
            Find any operational record by code (arrival card, carton, container, article, order) and, as admin,
            void duplicates or wrongly-created entries. Voiding is a soft, audited state change — never a delete.
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => { void loadLog(); }}>Refresh</button>
      </header>

      {!canCorrect && (
        <div className="ac-error" style={{ marginBottom: 12 }}>
          You can search and review, but only admins (permission <code>operations.correct</code>) can void records.
        </div>
      )}
      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}
      {flash && <div className="os-tag os-tag--ok" style={{ display: 'inline-block', marginBottom: 12 }}>{flash}</div>}

      {/* ---- Search ------------------------------------------------------ */}
      <section className="os-card">
        <label className="os-label" htmlFor="dc-q">
          Search by code — try WAR…, CTN…, RCN…, ART…, ORD…, a barcode, or customer info
        </label>
        <div className="os-row">
          <input
            id="dc-q"
            className="os-input"
            style={{ flex: 1, minWidth: 260, fontFamily: 'var(--os-font-mono)' }}
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. CTN-00012 or 00123A"
          />
          {searching && <span className="os-muted">searching…</span>}
        </div>
        {hits && hits.length > 0 && counts && (
          <div className="os-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {(Object.keys(counts) as DataControlKind[]).map((k) => (
              <span key={k} className="os-tag os-tag--info">
                {KIND_META[k].prefix} · {counts[k]}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ---- Search results ---------------------------------------------- */}
      <section className="os-card" style={{ marginTop: 14 }}>
        <div className="cc-head">
          <h2 className="os-card-title">Matches</h2>
        </div>
        {!q.trim() || q.trim().length < 2 ? (
          <div className="os-empty">Type at least 2 characters to search. Duplicate scans of the same code are all listed — void the exact wrong one.</div>
        ) : !hits ? (
          <div className="os-empty">{searching ? 'searching…' : 'No matches.'}</div>
        ) : hits.length === 0 ? (
          <div className="os-empty">No records match “{q.trim()}”.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr><th>Type</th><th>Code</th><th>Info</th><th>Status</th><th>Created</th><th /></tr>
              </thead>
              <tbody>
                {hits.map((h) => {
                  const terminal = TERMINAL.has(h.status);
                  return (
                    <tr key={`${h.kind}:${h.id}`}>
                      <td><span className="os-tag os-tag--info">{KIND_META[h.kind].title}</span></td>
                      <td className="mono">{h.code}</td>
                      <td className="os-muted">{h.label || '—'}</td>
                      <td><span className={`os-tag ${tone(h.status)}`}>{h.status.replace(/_/g, ' ')}</span></td>
                      <td className="os-muted">{new Date(h.createdAt).toLocaleString()}</td>
                      <td>
                        {canCorrect && !terminal && (
                          <button className="ac-linkbtn" onClick={() => setTarget(h)}>void</button>
                        )}
                        {canCorrect && terminal && (
                          <span className="os-muted" title="This record is already in a terminal state.">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- Recent voids ------------------------------------------------ */}
      <section className="os-card" style={{ marginTop: 14 }}>
        <h2 className="os-card-title">Recent voids (audit)</h2>
        {!voidLog ? (
          <div className="os-empty">loading…</div>
        ) : voidLog.length === 0 ? (
          <div className="os-empty">No voids recorded yet. When an admin voids a record it will appear here with the reason and the admin’s identity.</div>
        ) : (
          <div className="ac-scroll">
            <table className="os-table">
              <thead>
                <tr><th>At</th><th>Type</th><th>Code</th><th>Reason</th><th>Previous state</th><th>Admin</th></tr>
              </thead>
              <tbody>
                {voidLog.map((v) => (
                  <tr key={v.id}>
                    <td className="os-muted">{new Date(v.at).toLocaleString()}</td>
                    <td className="os-muted">{v.kind ?? '—'}</td>
                    <td className="mono">{v.code ?? '—'}</td>
                    <td>{v.reason ?? '—'}</td>
                    <td className="os-muted">{v.previousStatus ?? '—'}</td>
                    <td>{v.admin ? `${v.admin.name} (${v.admin.employeeCode})` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {target && (
        <VoidDialog
          hit={target}
          onConfirm={async (reason) => {
            const r = await adminApi.dataControlVoid(target.kind, target.code, reason, target.id);
            setTarget(null);
            setHits((prev) =>
              (prev ?? []).map((h) =>
                h.kind === target.kind && h.id === target.id
                  ? { ...h, status: r.status }
                  : h,
              ),
            );
            await loadLog();
            setFlash(`Voided ${target.kind} ${target.code} (${r.previousStatus} → ${r.status}${r.cascaded.length ? `; ${r.cascaded.length} linked record(s) also voided` : ''}).`);
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}

function VoidDialog({
  hit,
  onConfirm,
  onClose,
}: {
  hit: DataControlHit;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = reason.trim().length < 8;

  async function submit() {
    if (tooShort || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <div className="ac-modal-box">
        <h2 className="ac-modal-title">Void {KIND_META[hit.kind].title.toLowerCase()} {hit.code}?</h2>
        <p className="ac-sub">
          This is a soft void: the record is closed and hidden from live operational views, it is never deleted.
          A written reason and your identity are recorded in the audit trail.
        </p>
        <div className="ac-modal-warn">
          Current state: <b>{hit.status.replace(/_/g, ' ')}</b>. Voiding a container also voids its contents;
          voiding an order also voids its bins and articles. Records already packed, shipped or closed cannot be voided here.
        </div>
        <div>
          <label className="os-label" htmlFor="dc-reason">Reason (required)</label>
          <input
            id="dc-reason"
            className="os-input"
            value={reason}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. duplicated carton — same code scanned twice"
          />
        </div>
        {error && <div className="ac-error">{error}</div>}
        <div className="ac-modal-actions">
          <button type="button" className="os-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="os-btn os-btn--danger"
            onClick={submit}
            disabled={tooShort || busy}
            title={tooShort ? 'A reason of at least 8 characters is required' : undefined}
          >
            {busy ? 'Voiding…' : 'Void record'}
          </button>
        </div>
      </div>
    </div>
  );
}
