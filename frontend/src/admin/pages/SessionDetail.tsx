import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi, type AdminReportDetail, type SessionDetail as Detail } from '../api';
import { useAsync } from './useAsync';
import CorrectionDialog from './CorrectionDialog';
import { useAuth } from '../../context/AuthContext';

/**
 * Session drill-down (§37) with the authorised correction actions (§7/§39).
 * Everything here is read-only except the explicit, audited corrections.
 */
/**
 * ORDER 01 — verification report panel (Rapport de Confirme) inside the
 * session drill-down: full report, missing/damaged, manual notes, photos,
 * review/close actions and print-to-PDF (works with or without exceptions).
 */
function SessionReportPanel({ sessionCode, canCorrect }: { sessionCode: string; canCorrect: boolean }) {
  const { data: rows } = useAsync(() => adminApi.receivingReports({ q: sessionCode }), [sessionCode]);
  const mine = (rows ?? []).find((r) => r.sessionCode === sessionCode) ?? null;
  const { data: detail, loading, error, reload } = useAsync(
    () => (mine ? adminApi.receivingReport(mine.id) : Promise.resolve(null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine?.id],
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!mine && !loading) {
    return (
      <section className="os-card">
        <h2 className="os-card-title">📋 Rapport de Confirmé</h2>
        <div className="os-empty">Aucun rapport pour cette session.</div>
      </section>
    );
  }
  if (loading && !detail) {
    return (
      <section className="os-card">
        <h2 className="os-card-title">📋 Rapport de Confirmé</h2>
        <div className="os-empty">Chargement…</div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="os-card">
        <h2 className="os-card-title">📋 Rapport de Confirmé</h2>
        <div className="ac-error">{error}</div>
      </section>
    );
  }
  if (!detail) return null;
  const t = detail.totals;

  const review = async () => {
    const note = window.prompt('Note de révision (optionnel) :', '') ?? undefined;
    setBusy(true);
    setMsg(null);
    try {
      await adminApi.reviewReceivingReport(detail.id, note || undefined);
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Révision impossible.');
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (!window.confirm('Clôturer ce rapport ?')) return;
    setBusy(true);
    setMsg(null);
    try {
      await adminApi.closeReceivingReport(detail.id);
      await reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Clôture impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="os-card">
      <div className="os-spread">
        <h2 className="os-card-title" style={{ margin: 0 }}>
          📋 Rapport de Confirmé{' '}
          <span className={`os-tag ${detail.status === 'CLOSED' ? 'os-tag--ok' : 'os-tag--info'}`}>
            {detail.status}
          </span>
        </h2>
        <div className="os-row">
          <button type="button" className="os-btn" onClick={() => printReport(detail)}>
            🖨️ IMPRIMER / PDF
          </button>
          {canCorrect && detail.status === 'SUBMITTED' && (
            <button type="button" className="os-btn" disabled={busy} onClick={() => void review()}>
              RÉVISER
            </button>
          )}
          {canCorrect && (detail.status === 'SUBMITTED' || detail.status === 'REVIEWED') && (
            <button type="button" className="os-btn" disabled={busy} onClick={() => void close()}>
              CLÔTURER
            </button>
          )}
        </div>
      </div>
      {msg && <div className="ac-error">{msg}</div>}
      <p className="os-muted">
        {detail.session.code} · {detail.arrival.code} · {detail.arrival.customerName} · Tâche {detail.taskStatus}
        {detail.actor.workerName ? ` · ${detail.actor.workerName}` : ''}
        {detail.actor.stationCode ? ` · Station ${detail.actor.stationCode}` : ''}
        {detail.submittedAt ? ` · Envoyé le ${new Date(detail.submittedAt).toLocaleString()}` : ''}
      </p>
      <div className="os-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {[
          ['Attendus', t.expectedUnits],
          ['Scannés', t.scannedUnits],
          ['Confirmés', t.confirmedUnits],
          ['Manquants', t.missingUnits],
          ['Endommagés', t.damagedUnits],
          ['Cartons', `${t.receivedCartons}/${t.expectedCartons}`],
        ].map(([label, value]) => (
          <span key={label as string} className="os-tag os-tag--info">
            {label as string}: {value as string | number}
          </span>
        ))}
      </div>
      <table className="os-table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>SKU / Réf</th>
            <th>Produit</th>
            <th>Att</th>
            <th>Scan</th>
            <th>Conf</th>
            <th>Manq</th>
            <th>Endom</th>
            <th>Résultat</th>
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((l) => (
            <tr key={l.id}>
              <td className="mono">{l.sku ?? l.reference ?? '—'}</td>
              <td>{l.productName ?? '—'}</td>
              <td>{l.expectedQuantity}</td>
              <td>{l.scannedQuantity}</td>
              <td>{l.confirmedQuantity}</td>
              <td>{l.missingQuantity}</td>
              <td>{l.damagedQuantity}</td>
              <td>
                <span
                  className={`os-tag ${
                    l.result === 'CONFIRMED' ? 'os-tag--ok' : l.result === 'PENDING' ? 'os-tag--info' : 'os-tag--err'
                  }`}
                >
                  {l.result}
                </span>
              </td>
            </tr>
          ))}
          {detail.lines.length === 0 && (
            <tr>
              <td colSpan={8} className="os-empty">
                Aucune ligne.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {(detail.manual.description || detail.manual.observation || detail.reviewNote) && (
        <div className="os-muted" style={{ marginTop: 8 }}>
          {detail.manual.description && <p style={{ margin: '2px 0' }}>📝 {detail.manual.description}</p>}
          {detail.manual.observation && <p style={{ margin: '2px 0' }}>💬 {detail.manual.observation}</p>}
          {detail.reviewNote && <p style={{ margin: '2px 0' }}>✅ Révision: {detail.reviewNote}</p>}
        </div>
      )}
      {detail.photos.length > 0 && (
        <div className="os-row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {detail.photos.map((p) => (
            <img
              key={p.id}
              src={p.dataUrl}
              alt={p.caption ?? 'photo'}
              title={p.caption ?? ''}
              style={{ width: 140, height: 105, objectFit: 'cover', borderRadius: 6 }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** ORDER 01 — standalone printable report (browser print-to-PDF, no dependency). */
function printReport(r: AdminReportDetail) {
  const esc = (v: unknown) =>
    String(v ?? '—')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const t = r.totals;
  const line = (l: AdminReportDetail['lines'][number]) =>
    `<tr><td>${esc(l.sku ?? l.reference)}</td><td>${esc(l.productName)}</td><td>${l.expectedQuantity}</td>` +
    `<td>${l.scannedQuantity}</td><td>${l.confirmedQuantity}</td><td>${l.missingQuantity}</td>` +
    `<td>${l.damagedQuantity}</td><td><strong>${esc(l.result)}</strong></td></tr>`;
  const photos = r.photos
    .map((p) => `<figure><img src="${p.dataUrl}" alt="${esc(p.caption)}" /><figcaption>${esc(p.caption)}</figcaption></figure>`)
    .join('');
  const doc = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8" />
<title>Rapport de Confirmé — ${esc(r.session.code)}</title>
<style>
body{font-family:Arial,sans-serif;color:#111;margin:24px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:18px 0 6px}
.meta{color:#444;margin:6px 0 0}.tag{display:inline-block;border:1px solid #111;border-radius:4px;padding:1px 8px;font-size:12px;margin-left:8px}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border:1px solid #999;padding:5px 7px;font-size:12px;text-align:left}
.totals td{font-weight:bold}.photos{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;width:220px}
figure img{width:220px;max-height:165px;object-fit:cover;border:1px solid #999}figcaption{font-size:11px;color:#444}
.sign{display:flex;gap:40px;margin-top:28px}.sign div{border-top:1px solid #111;padding-top:4px;width:220px;font-size:12px}
@media print{.noprint{display:none}}</style></head><body>
<h1>📋 Rapport de Confirmé <span class="tag">${esc(r.status)}</span></h1>
<p class="meta">Session <strong>${esc(r.session.code)}</strong> · Arrivée <strong>${esc(r.arrival.code)}</strong> · Client <strong>${esc(
      r.arrival.customerName,
    )}</strong></p>
<p class="meta">Agent: <strong>${esc(r.actor.workerName)}</strong> · Station: <strong>${esc(
      r.actor.stationCode,
    )}</strong> · Appareil: ${esc(r.actor.deviceType)} ${esc(r.actor.deviceName)}</p>
<p class="meta">Envoyé: ${esc(r.submittedAt ? new Date(r.submittedAt).toLocaleString() : null)}${
      r.reviewedAt ? ` · Révisé: ${esc(new Date(r.reviewedAt).toLocaleString())}` : ''
    }${r.closedAt ? ` · Clôturé: ${esc(new Date(r.closedAt).toLocaleString())}` : ''}</p>
<h2>Totaux</h2>
<table class="totals"><tr><td>Attendus: ${t.expectedUnits}</td><td>Scannés: ${t.scannedUnits}</td><td>Confirmés: ${
      t.confirmedUnits
    }</td><td>Manquants: ${t.missingUnits}</td><td>Endommagés: ${t.damagedUnits}</td><td>Cartons: ${
      t.receivedCartons
    }/${t.expectedCartons}</td></tr></table>
<h2>Produits (${r.lines.length})</h2>
<table><thead><tr><th>SKU / Réf</th><th>Produit</th><th>Att</th><th>Scan</th><th>Conf</th><th>Manq</th><th>Endom</th><th>Résultat</th></tr></thead>
<tbody>${r.lines.map(line).join('') || '<tr><td colspan="8">Aucune ligne.</td></tr>'}</tbody></table>
${r.manual.description ? `<h2>Description</h2><p>${esc(r.manual.description)}</p>` : ''}
${r.manual.observation ? `<h2>Observation</h2><p>${esc(r.manual.observation)}</p>` : ''}
${r.reviewNote ? `<h2>Note de révision</h2><p>${esc(r.reviewNote)}</p>` : ''}
${r.photos.length ? `<h2>Photos (${r.photos.length})</h2><div class="photos">${photos}</div>` : ''}
<div class="sign"><div>Agent (signature)</div><div>Responsable (signature)</div></div>
<p class="noprint" style="margin-top:16px"><button onclick="window.print()">Imprimer / PDF</button></p>
<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),400));</script>
</body></html>`;
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(doc);
  w.document.close();
  w.focus();
}

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

  if (loading && !data) return <div className="os-empty">loading session…</div>;
  if (error) return <div className="ac-error">{error}</div>;
  if (!data) return null;

  const s = data.session;
  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Session {s.code}</h1>
          <p className="ac-sub">
            <span className={`os-tag ${s.status === 'COMPLETED' ? 'os-tag--ok' : s.status === 'RECEIVING' ? 'os-tag--warn' : 'os-tag--info'}`}>
              {s.status}
            </span>
            {' '}{s.worker?.name ?? 'unknown worker'} · {s.arrival?.code ?? '—'} ·{' '}
            {new Date(s.startedAt).toLocaleString()} · {s.deviceType ?? 'device n/a'}
            {s.station ? ` · ${s.station.code}` : ''}
            {s.completedAt ? ` · completed ${new Date(s.completedAt).toLocaleString()}` : ' · not completed'}
          </p>
        </div>
        <div className="os-row">
          {canCorrect && s.status !== 'RECEIVING' && (
            <button type="button" className="os-btn" onClick={() => setReopen(true)}>Reopen</button>
          )}
          <button type="button" className="os-btn" onClick={() => navigate(-1)}>Back</button>
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
            <h2 className="os-card-title">Cartons ({data.cartons.length})</h2>
            <table className="os-table">
              <thead>
                <tr><th>Carton ID</th><th>Reference</th><th>QR / Barcode</th><th>Scanned</th><th>Source</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {data.cartons.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.carton?.externalCartonId ?? c.carton?.id ?? '—'}</td>
                    <td className="mono">{c.carton?.cartonReference ?? '—'}</td>
                    <td className="mono os-muted">
                      {c.carton
                        ? [c.carton.qrCodeValue, c.carton.barcodeValue].filter(Boolean).join(' / ') || '—'
                        : '—'}
                    </td>
                    <td className="mono">{c.scannedCode}</td>
                    <td className="os-muted">{c.source}</td>
                    <td>
                      <span className={`os-tag ${c.status === 'RECEIVED' ? 'os-tag--ok' : 'os-tag--warn'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td>
                      {canCorrect && c.status === 'RECEIVED' && (
                        <button className="ac-linkbtn" onClick={() => setReverse(c)}>reverse</button>
                      )}
                    </td>
                  </tr>
                ))}
                {data.cartons.length === 0 && <tr><td colSpan={7} className="os-empty">No carton events.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Products ({data.products.length})</h2>
            <table className="os-table">
              <thead><tr><th>SKU</th><th>Reference</th><th>Product</th><th>Recv/Exp</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.sku ?? '—'}</td>
                    <td className="mono">{p.reference ?? '—'}</td>
                    <td>{p.productName ?? '—'}</td>
                    <td>{p.receivedQuantity}/{p.expectedQuantity}</td>
                    <td><span className="os-tag os-tag--info">{p.status}</span></td>
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
                {data.products.length === 0 && <tr><td colSpan={6} className="os-empty">No product lines.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Discrepancies / reported issues ({data.discrepancies.length})</h2>
            {data.discrepancies.length === 0 ? (
              <div className="os-empty">No discrepancies reported.</div>
            ) : (
              <table className="os-table">
                <thead><tr><th>Type</th><th>Status</th><th>Reason</th></tr></thead>
                <tbody>
                  {data.discrepancies.map((d) => (
                    <tr key={d.id}>
                      <td>{d.type.replace(/_/g, ' ')}</td>
                      <td>
                        <span className={`os-tag ${d.status === 'OPEN' ? 'os-tag--err' : 'os-tag--ok'}`}>{d.status}</span>
                      </td>
                      <td className="os-muted">{d.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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

      <SessionReportPanel sessionCode={s.code} canCorrect={canCorrect} />

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
