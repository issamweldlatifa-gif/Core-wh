import { useEffect, useRef, useState } from 'react';
import { BarcodeFormat, MultiFormatWriter } from '@zxing/library';
import { useAuth } from '../../context/AuthContext';
import { apiErrorMessage } from '../../api/client';
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
 * arrivals flow): review worker-created customers (needsReview tag) →
 * ONE fused "Accept & send to receiving" click (both endpoints fire, audit
 * keeps both transitions — owner decision 2026-09-12); VOID+reason instead
 * of delete. Buttons are the pure batchActions() matrix (status ×
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
  'accept-send': 'Accept & send to receiving',
  send: 'Send to receiving',
  void: 'Void…',
  print: 'Print label',
};

const ACTION_CLASS: Record<BatchUiAction, string> = {
  'accept-send': 'os-btn os-btn--primary',
  send: 'os-btn os-btn--primary',
  void: 'os-btn os-btn--danger',
  print: 'os-btn os-btn--ghost',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/** CODE 128 of the batch code, drawn locally (zxing encode → canvas). */
function drawBatchBarcode(canvas: HTMLCanvasElement | null, value: string) {
  if (!canvas) return;
  const width = 560;
  const height = 120;
  const matrix = new MultiFormatWriter().encode(value, BarcodeFormat.CODE_128, width, height, new Map());
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  const cell = width / matrix.getWidth();
  for (let x = 0; x < matrix.getWidth(); x += 1) {
    if (matrix.get(x, 0)) {
      ctx.fillRect(Math.floor(x * cell), 0, Math.ceil(cell), height);
    }
  }
}

/** Transient print surface (self-contained styles; nothing else prints).
 * OWNER LABEL CONTRACT: the barcode + its number beneath — nothing else. */
function BatchPrintLabel({ code, canvasRef }: {
  code: string;
  canvasRef: React.RefObject<HTMLCanvasElement>;
}) {
  return (
    <div className="ac-bprint">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .ac-bprint, .ac-bprint * { visibility: visible !important; }
          .ac-bprint { position: absolute; inset: 0; background: #fff; padding: 24px; }
        }
        .ac-bprint { display: flex; flex-direction: column; align-items: center; gap: 10px; background: #fff; color: #000; padding: 16px; }
        .ac-bprint canvas { width: 560px; max-width: 92vw; height: 120px; image-rendering: pixelated; }
        .ac-bprint h2 { margin: 0; font-size: 26px; letter-spacing: 0.1em; }
      `}</style>
      <canvas ref={canvasRef} aria-hidden="true" />
      <h2>{code}</h2>
    </div>
  );
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
  const [printCode, setPrintCode] = useState<{ code: string } | null>(null);
  const printCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (printCode) drawBatchBarcode(printCanvas.current, printCode.code);
  }, [printCode]);

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
    if (action === 'print') {
      setPrintCode({ code: row.batchCode });
      setTimeout(() => {
        window.print();
        setPrintCode(null);
      }, 80);
      return;
    }
    if (action === 'void') {
      setVoidTarget(row);
      setVoidReason('');
      return;
    }
    // OWNER DECISION: one click — accept then send fire back-to-back (both
    // audited server-side). If the send leg fails the batch stays ACCEPTED
    // and the card offers the plain Send button (recovery path).
    if (action === 'accept-send') {
      void act(async () => {
        await batchesAdminApi.accept(row.id, operatorId);
        await batchesAdminApi.send(row.id, operatorId);
      });
    }
    if (action === 'send') void act(() => batchesAdminApi.send(row.id, operatorId));
  }

  const rows = batches.data ?? [];

  return (
    <div>
      <h1 className="ac-title">Batches</h1>
      <p className="ac-sub">
        AYROVI batch cards — review → accept → print → send to receiving. VOID+audit replaces delete.
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
                  <button key={a} disabled={busy} className={ACTION_CLASS[a]} onClick={() => onAction(row, a)}>
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

      {printCode && (
        <BatchPrintLabel code={printCode.code} canvasRef={printCanvas} />
      )}
    </div>
  );
}
