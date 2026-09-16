import { useState } from 'react';

import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
import { printLabelsInNewWindow } from '../print-sheet';
import { printerBridge, newJobId, type BridgeStatus } from '../printer-bridge';
import {
  BATCH_STATUS_TAG,
  batchActions,
  batchesAdminApi,
  type BatchDetail,
  type BatchRow,
  type BatchUiAction,
} from '../batches';
import { useAsync } from './useAsync';

/**
 * AYROVI BATCH — Admin board (Phase 2 slice 3).
 *
 * The batch card is its OWN isolated board (never mixed into the CRM
 * arrivals flow): the worker's SUBMIT routes the batch DIRECTLY to
 * receiving (atomically server-side — owner order 2026-09-13, revised: NO
 * admin approval). The board is view + print (+ VOID+reason instead of
 * delete). Buttons are the pure batchActions() matrix (status ×
 * permissions, mirroring the backend state machine); every click is
 * re-validated server-side.
 *
 * Print = the batch identity through the browser print dialog: a LINEAR
 * CODE 128 barcode of the AYB code with the code printed beneath it —
 * nothing else (owner label contract 2026-09-12). Encoded locally with the
 * already-bundled @zxing/library; the WORKER app prints per-unit AYP labels
 * under the same contract. This prints the PARCEL (batch) label only.
 */

const STATUSES = [
  'CREATED',
  'SUBMITTED',
  'ACCEPTED',
  'SENT_TO_RECEIVING',
  'RECEIVING_IN_PROGRESS',
  'RECEIVING_COMPLETED',
  'VOIDED',
];

const ACTION_LABEL: Record<BatchUiAction, string> = {
  void: 'Void…',
  print: 'PDF label',
  printBt: 'Print PM-241',
  delete: 'Delete',
};

const ACTION_CLASS: Record<BatchUiAction, string> = {
  void: 'os-btn os-btn--danger',
  print: 'os-btn os-btn--ghost',
  printBt: 'os-btn os-btn--primary',
  delete: 'os-btn os-btn--danger',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}



export default function BatchesAdmin() {
  const { me, hasPermission } = useAuth();
  const operatorId = me?.user?.id ?? 'admin';

  const [status, setStatus] = useState<string>('');
  const batches = useAsync(() => batchesAdminApi.list(status || undefined), [status]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useAsync(
    () => (selectedId ? batchesAdminApi.get(selectedId) : Promise.resolve(null as BatchDetail | null)),
    [selectedId],
  );

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<BatchRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  // OWNER 2026-09-14: hard delete (any status, audited, units cascade).
  const [deleteTarget, setDeleteTarget] = useState<BatchRow | null>(null);
  // Direct thermal print through the CT40 bridge (PM-241-BT over SPP).
  // OWNER 2026-09-16: direct thermal print with a real step loading bar —
  // no browser print dialog, no 'Save as PDF' ever.
  const [btPrint, setBtPrint] = useState<{ step: number; detail: string; error: string | null; code: string } | null>(null);
  async function printDirect(row: BatchRow) {
    setBtPrint({ step: 1, detail: '', error: null, code: row.batchCode });
    try {
      setBtPrint({ step: 1, detail: 'Bridge check...', error: null, code: row.batchCode });
      const st: BridgeStatus = await printerBridge.status();
      if (!st.bridge) {
        setBtPrint({ step: 0, detail: '', error:
          'Print bridge not reachable from THIS browser. The printer is attached to the CT40: (1) open this Admin page in the CT40 Chrome, (2) AYROVI worker app - SETTINGS - PRINTER BRIDGE - ENABLE, keep the app running, (3) if Chrome asks for Local network access permission - Allow it, then Retry.', code: row.batchCode });
        return;
      }
      if (st.state !== 'CONNECTED') {
        if (st.printer?.address) {
          setBtPrint({ step: 2, detail: 'Connecting printer...', error: null, code: row.batchCode });
          await printerBridge.connect(st.printer.address, st.printer.name);
        } else {
          setBtPrint({ step: 0, detail: '', error:
            'No PM-241-BT saved yet. On the CT40 open Admin - Printers - Search - connect the printer ONCE; after that every print auto-connects.', code: row.batchCode });
          return;
        }
      }
      setBtPrint({ step: 3, detail: 'Sending TSPL to PM-241-BT...', error: null, code: row.batchCode });
      await printerBridge.printBarcode(newJobId(), {
        title: 'BATCH',
        containerCode: row.batchCode,
        qrPayload: row.batchCode,
        barcodeValue: row.batchCode,
      });
      setBtPrint({ step: 4, detail: 'Label sent - check the printer.', error: null, code: row.batchCode });
      window.setTimeout(() => setBtPrint(null), 2500);
    } catch (e) {
      setBtPrint({ step: 0, detail: '', error: 'Printer error: ' + (e instanceof Error ? e.message : String(e)), code: row.batchCode });
    }
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await batches.reload();
      if (selectedId) await detail.reload();
    } catch (e) {
      setErr(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function onAction(row: BatchRow, action: BatchUiAction) {
    if (action === 'printBt') {
      void printDirect(row);
      return;
    }
    if (action === 'print') {
      // Self-contained print tab (Android-Chrome-safe; print-sheet.tsx).
      try {
        if (!printLabelsInNewWindow([row.batchCode])) {
          window.alert('Pop-up blocked — allow pop-ups for this site, then try again.');
        }
      } catch (e) {
        window.alert(`Print error: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (action === 'delete') {
      setDeleteTarget(row);
      return;
    }
    if (action === 'void') {
      setVoidTarget(row);
      setVoidReason('');
      return;
    }
    // OWNER ORDER (2026-09-13, revised): NO admin approval exists — the
    // worker's submit routed the batch directly to receiving server-side.
    // The admin board is view + print (+ VOID).
  }

  const rows = batches.data ?? [];

  return (
    <div>
      <h1 className="ac-title">Batches</h1>
      <p className="ac-sub">
        AYROVI batch cards — submitted batches route DIRECTLY to receiving (automatic; nothing to approve here). Review, print, VOID+audit.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }}>
        <button className={`os-btn ${status === '' ? 'os-btn--primary' : ''}`} onClick={() => setStatus('')}>
          All
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`os-btn ${status === s ? 'os-btn--primary' : ''}`}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {err && <div className="ac-error" role="alert">{err}</div>}
      {batches.error && <div className="ac-error" role="alert">{batches.error}</div>}
      {batches.loading && <p className="os-muted">Loading…</p>}

      {rows.map((row) => {
        const actions = batchActions(row.status, hasPermission);
        const tag = BATCH_STATUS_TAG[row.status] ?? 'os-tag os-tag--muted';
        const detailOpen = selectedId === row.id;
        return (
          <section key={row.id} className="os-card" style={{ marginBottom: 12 }}>
            <div className="os-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="os-btn os-btn--ghost"
                style={{ fontWeight: 700, letterSpacing: '0.06em' }}
                onClick={() => setSelectedId(detailOpen ? null : row.id)}
              >
                {row.batchCode}
              </button>
              <span className={`os-tag ${tag.startsWith('os-tag--') ? tag : tag}`}>{row.status}</span>
              {row.customer?.needsReview && (
                <span className="os-tag os-tag--warn" title="Customer created by the worker — review">
                  needsReview
                </span>
              )}
            </div>
            <div className="os-row os-muted" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
              <span>Customer: {row.customer?.name ?? '—'}</span>
              <span>Units: {row.totalScanned}/{row.totalExpected}</span>
              <span>Created: {fmt(row.createdAt)}</span>
              {row.voidedAt && <span>Voided: {fmt(row.voidedAt)}</span>}
            </div>
            {row.voidReason && <p className="os-muted" style={{ fontSize: 13 }}>Reason: {row.voidReason}</p>}
            {actions.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {actions.map((a) => (
                  <button key={a} disabled={busy || (a === 'printBt' && btPrint !== null)} className={ACTION_CLASS[a]} onClick={() => onAction(row, a)}>
                    {ACTION_LABEL[a]}
                  </button>
                ))}
              </div>
            )}
            {detailOpen && (
              <div style={{ marginTop: 10 }}>
                {detail.loading && <p className="os-muted">Loading units…</p>}
                {detail.error && <div className="ac-error">{detail.error}</div>}
                {detail.data && (
                  <table className="os-table">
                    <thead>
                      <tr>
                        <th>AYROVI unit</th>
                        <th>Original</th>
                        <th>Identifier</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.items.map((it) => (
                        <tr key={it.id}>
                          <td><code>{it.unit.code}</code></td>
                          <td className="os-muted">
                            {it.unit.originalBarcode || it.unit.originalSku || it.unit.originalReference || <em>MANUAL (no original)</em>}
                          </td>
                          <td>{it.identifierType}: {it.identifierValue ?? '—'}</td>
                          <td>{it.status === 'RECEIVED' ? '✅ RECEIVED' : it.status}</td>
                        </tr>
                      ))}
                      {detail.data.items.length === 0 && (
                        <tr>
                          <td colSpan={4} className="os-empty">No units yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        );
      })}
      {!batches.loading && rows.length === 0 && <p className="os-empty">No batches{status ? ` in ${status}` : ''}.</p>}

      {deleteTarget && (
        <div className="ac-modal" role="dialog" aria-modal="true" aria-label="Delete batch">
          <div className="ac-modal-box">
            <h2 className="ac-modal-title">DELETE {deleteTarget.batchCode}</h2>
            <p className="ac-modal-warn">
              Permanent removal — the batch and its {deleteTarget.totalScanned}/{deleteTarget.totalExpected} unit
              records are deleted now. This cannot be undone (an audit entry keeps what was removed).
            </p>
            <div className="ac-modal-actions">
              <button className="os-btn" onClick={() => setDeleteTarget(null)} disabled={busy}>Cancel</button>
              <button
                className="os-btn os-btn--danger"
                disabled={busy}
                onClick={() => {
                  const target = deleteTarget;
                  setDeleteTarget(null);
                  void act(() => batchesAdminApi.remove(target.id));
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {voidTarget && (
        <div className="ac-modal" role="dialog" aria-modal="true" aria-label="Void batch">
          <div className="ac-modal-box">
            <h2 className="ac-modal-title">Void {voidTarget.batchCode}</h2>
            <p className="ac-modal-warn">No data is deleted — the batch is marked VOIDED with your reason (audited).</p>
            <label className="os-label" htmlFor="batch-void-reason">Reason (mandatory)</label>
            <textarea
              id="batch-void-reason"
              className="os-input"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Why is this batch being voided…"
              rows={3}
            />
            <div className="ac-modal-actions">
              <button className="os-btn" onClick={() => setVoidTarget(null)} disabled={busy}>Cancel</button>
              <button
                className="os-btn os-btn--danger"
                disabled={busy || voidReason.trim().length < 3}
                onClick={() => {
                  const target = voidTarget;
                  setVoidTarget(null);
                  void act(() => batchesAdminApi.voidBatch(target.id, operatorId, voidReason.trim()));
                }}
              >
                Void batch
              </button>
            </div>
          </div>
        </div>
      )}

      {btPrint && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(4,10,16,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => { if (btPrint.error || btPrint.step === 4) setBtPrint(null); }}>
          <div style={{ background: 'var(--panel,#0f1822)', border: '1px solid var(--line,#24303d)', borderRadius: 12, padding: '22px 26px', width: 'min(92vw, 430px)', color: 'inherit' }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{btPrint.error ? 'PRINT PROBLEM' : `Printing ${btPrint.code}`}</div>
            {btPrint.error ? (
              <div style={{ fontSize: '0.85rem', lineHeight: 1.7, color: '#ff5d5d' }}>{btPrint.error}</div>
            ) : (
              <>
                <div style={{ height: 10, borderRadius: 999, background: 'rgba(128,160,190,.18)', overflow: 'hidden', margin: '14px 0 8px' }}>
                  <div style={{ width: `${btPrint.step * 25}%`, height: '100%', background: 'linear-gradient(90deg,#2f9dff,#39d98a)', transition: 'width .4s ease' }} />
                </div>
                <div style={{ fontSize: '0.85rem', opacity: 0.85 }}>{btPrint.detail || (btPrint.step === 4 ? 'Done.' : 'Working...')}</div>
              </>
            )}
            {(btPrint.error || btPrint.step === 4) && (
              <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
                {btPrint.error && (
                  <button className="os-btn" onClick={() => { const c = btPrint.code; setBtPrint(null); const row = batches.data?.find((b) => b.id && b.batchCode === c); if (row) void printDirect(row); }}>Retry</button>
                )}
                <button className="os-btn os-btn--primary" onClick={() => setBtPrint(null)}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
