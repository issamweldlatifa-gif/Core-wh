import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api as receivingApi,
  type ReceivingReportPhotoInput,
  type ReceivingReportView,
} from '../modules/receiving/api';
import { beepError, beepSuccess, beepWarning } from '../modules/receiving-terminal/feedback';
import './receiving-report.css';

/**
 * ORDER 01 — "Rapport de Confirmé" (worker verification report).
 *
 * Without :sessionId it lists the worker's sessions with an active receiving
 * session (arrival -> active session). With :sessionId it shows the live
 * auto verification (totals + per-product CONFIRMED/MISSING/DAMAGED/PENDING),
 * the manual fields (description / observation / photos) and CONFIRMER ET
 * ENVOYER. A locked (SUBMITTED+) report is read-only.
 */

interface SessionChoice {
  sessionId: string;
  sessionCode: string;
  sessionStatus: string;
  arrivalCode: string;
  customerName: string;
}

const RESULT_FR: Record<string, string> = {
  PENDING: 'EN ATTENTE',
  CONFIRMED: 'CONFIRMÉ',
  MISSING: 'MANQUANT',
  DAMAGED: 'ENDOMMAGÉ',
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.readAsDataURL(file);
  });
}

export default function ReceivingReport() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [choices, setChoices] = useState<SessionChoice[] | null>(null);
  const [view, setView] = useState<ReceivingReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [description, setDescription] = useState('');
  const [observation, setObservation] = useState('');
  const [photos, setPhotos] = useState<ReceivingReportPhotoInput[]>([]);
  const [damageQty, setDamageQty] = useState<Record<string, string>>({});
  const [damageNote, setDamageNote] = useState<Record<string, string>>({});

  const loadChoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // ORDER 04 — the report resolves the worker's open session with ONE
      // call. The per-arrival probe loop below is only the fallback for old
      // backends; a probe failure never aborts the resolution.
      const direct = await receivingApi.activeSession();
      if (direct) {
        setChoices([
          {
            sessionId: direct.id,
            sessionCode: direct.code,
            sessionStatus: direct.status,
            arrivalCode: direct.arrival.code,
            customerName: direct.arrival.customerName,
          },
        ]);
        return;
      }
      const arrivals = await receivingApi.arrivals();
      const settled = await Promise.allSettled(arrivals.map((a) => receivingApi.active(a.code)));
      const list: SessionChoice[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          list.push({
            sessionId: r.value.id,
            sessionCode: r.value.code,
            sessionStatus: r.value.status,
            arrivalCode: arrivals[i].code,
            customerName: arrivals[i].customerName,
          });
        }
      });
      setChoices(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadView = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      setDone(null);
      try {
        const v = await receivingApi.report(id);
        setView(v);
        setDescription(v.manual?.description ?? '');
        setObservation(v.manual?.observation ?? '');
        setPhotos(
          (v.photos ?? []).map((p) => ({ dataUrl: p.dataUrl, caption: p.caption ?? null, lineId: p.lineId ?? null })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Chargement impossible.');
        beepError();
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (sessionId) void loadView(sessionId);
    else void loadChoices();
  }, [sessionId, loadView, loadChoices]);

  const editable = !!view && (view.reportStatus === 'NONE' || view.reportStatus === 'DRAFT');

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      const urls = await Promise.all(Array.from(files).slice(0, 10).map(fileToDataUrl));
      setPhotos((prev) =>
        [...prev, ...urls.map((dataUrl) => ({ dataUrl, caption: null, lineId: null }))].slice(0, 10),
      );
    } catch {
      setError('Lecture des photos impossible.');
      beepError();
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveDraft = async () => {
    if (!view || !editable) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const v = await receivingApi.saveReport(view.session.id, { description, observation, photos });
      setView(v);
      setDone('Brouillon enregistré.');
      beepSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
      beepError();
    } finally {
      setBusy(false);
    }
  };

  const declareDamage = async (lineId: string | null) => {
    if (!view || !lineId) return;
    const qty = Math.floor(Number(damageQty[lineId] ?? 0));
    if (qty < 1) {
      setError('Quantité endommagée invalide.');
      beepWarning();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await receivingApi.markDamage(view.session.id, lineId, {
        quantity: qty,
        note: damageNote[lineId] || undefined,
      });
      await loadView(view.session.id);
      beepSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Déclaration impossible.');
      beepError();
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!view || !editable) return;
    if (!window.confirm('CONFIRMER ET ENVOYER ce rapport ? Le rapport sera verrouillé.')) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const v = await receivingApi.submitReport(view.session.id, { description, observation, photos });
      setView(v);
      setDone(`Rapport envoyé et verrouillé. Admins notifiés: ${v.notifiedAdmins ?? 0}.`);
      beepSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Envoi impossible.');
      beepError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rr">
      <header className="rh-head">
        <div>
          <h1 className="rh-title">📋 RAPPORT DE CONFIRMÉ</h1>
          <p className="os-muted">Vérification de réception — données auto + constats manuels + photos.</p>
        </div>
        <div className="os-row">
          {sessionId && (
            <button type="button" className="os-btn" onClick={() => navigate('/terminal/receiving/report')}>
              SESSIONS
            </button>
          )}
          <button type="button" className="os-btn" onClick={() => navigate('/terminal/receiving')}>
            RETOUR
          </button>
        </div>
      </header>

      {loading && <div className="os-empty">Chargement…</div>}
      {error && (
        <div className="rt-error">
          {error}
          {/* Terminal error is never a dead end: an explicit RETRY re-runs the
              whole open sequence (resolve session + load). */}
          <div className="os-row">
            <button
              type="button"
              className="os-btn os-btn--primary"
              onClick={() => {
                if (sessionId) void loadView(sessionId);
                else void loadChoices();
              }}
            >
              RETRY
            </button>
          </div>
        </div>
      )}
      {done && <div className="rr-done">{done}</div>}

      {/* ---------- session picker ---------- */}
      {!sessionId && choices && (
        <section className="os-card">
          <h2 className="os-card-title">Sessions de réception ({choices.length})</h2>
          {choices.length === 0 ? (
            <p className="os-muted">Aucune session active. Démarrez une réception d&apos;abord.</p>
          ) : (
            <ol className="rh-rows">
              {choices.map((c) => (
                <li key={c.sessionId} className="rh-row rr-choice">
                  <span className="mono">{c.sessionCode}</span>
                  <span className="os-muted rh-row-meta">
                    {c.arrivalCode} · {c.customerName} · {c.sessionStatus}
                  </span>
                  <button
                    type="button"
                    className="os-btn os-btn--primary"
                    onClick={() => navigate(`/terminal/receiving/report/${c.sessionId}`)}
                  >
                    OUVRIR
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* ---------- report ---------- */}
      {view && (
        <>
          <section className="os-card">
            <div className="os-spread">
              <div>
                <h2 className="os-card-title">
                  {view.session.code} · {view.arrival.code} · {view.arrival.customerName}
                </h2>
                <p className="os-muted">
                  Tâche: <strong>{view.taskStatus}</strong> · Rapport: <strong>{view.reportStatus}</strong>
                  {view.actor?.stationCode ? ` · Station ${view.actor.stationCode}` : ''}
                  {view.actor?.workerName ? ` · ${view.actor.workerName}` : ''}
                </p>
                {view.session.startedAt && (
                  <p className="os-muted">
                    Démarré: <strong className="mono">{new Date(view.session.startedAt).toLocaleString()}</strong>
                    {view.submittedAt ? (
                      <>
                        {' '}· Envoyé:{' '}
                        <strong className="mono">{new Date(view.submittedAt).toLocaleString()}</strong>
                      </>
                    ) : null}
                  </p>
                )}
              </div>
              {!editable && <span className="os-tag os-tag--info">VERROUILLÉ</span>}
            </div>
            <div className="rr-totals">
              {[
                ['Attendus', view.totals?.expectedUnits ?? 0],
                ['Scannés', view.totals?.scannedUnits ?? 0],
                ['Confirmés', view.totals?.confirmedUnits ?? 0],
                ['Manquants', view.totals?.missingUnits ?? 0],
                ['Endommagés', view.totals?.damagedUnits ?? 0],
                ['Cartons', `${view.totals?.receivedCartons ?? 0}/${view.totals?.expectedCartons ?? 0}`],
              ].map(([label, value]) => (
                <div key={label as string} className="rr-total">
                  <span className="rr-total-v">{value}</span>
                  <span className="rr-total-l">{label}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Output A — Carton Flow detail: every expected carton appears with
              its own identity (suivi / tracking). Auto-filled from the
              verification — no manual entry. */}
          <section className="os-card">
            <h2 className="os-card-title">
              Cartons ({view.totals.receivedCartons}/{view.totals.expectedCartons} reçus)
            </h2>
            <div className="rr-table-wrap">
              <table className="os-table">
                <thead>
                  <tr>
                    <th>Carton</th>
                    <th>Réf / N°</th>
                    <th>Suivi</th>
                    <th>Résultat</th>
                    <th>Date / Heure</th>
                  </tr>
                </thead>
                <tbody>
                  {(view.cartons?.received ?? []).map((c, i) => (
                    <tr key={`r-${c.scannedCode ?? i}`}>
                      <td className="mono">{c.carton?.externalCartonId ?? c.scannedCode ?? '—'}</td>
                      <td className="mono">
                        {c.carton?.cartonReference ??
                          `Carton ${c.carton?.cartonNumber ?? ''}/${c.carton?.totalCartons ?? ''}`}
                      </td>
                      <td className="mono">{c.carton?.suiviCode ?? c.carton?.trackingCode ?? '—'}</td>
                      <td>
                        <span className="os-tag os-tag--ok">{c.status === 'RECEIVED' ? 'REÇU' : c.status}</span>
                      </td>
                      <td className="mono">{c.receivedAt ? new Date(c.receivedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                  {(view.cartons?.missing ?? []).map((c) => (
                    <tr key={`m-${c.id ?? c.externalCartonId}`}>
                      <td className="mono">{c.externalCartonId ?? '—'}</td>
                      <td className="mono">
                        {c.cartonReference ?? `Carton ${c.cartonNumber ?? ''}/${c.totalCartons ?? ''}`}
                      </td>
                      <td className="mono">{c.suiviCode ?? c.trackingCode ?? '—'}</td>
                      <td>
                        <span className="os-tag os-tag--err">MANQUANT</span>
                      </td>
                      <td className="mono">—</td>
                    </tr>
                  ))}
                  {(view.cartons?.received.length === 0 && view.cartons?.missing.length === 0) ||
                  !view.cartons ? (
                    <tr>
                      <td colSpan={5} className="os-empty">
                        {view.totals.expectedCartons > 0
                          ? 'Aucun détail carton disponible.'
                          : 'Aucun carton attendu sur cette réception.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Produits ({(view.lines ?? []).length})</h2>
            <div className="rr-table-wrap">
              <table className="os-table">
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
                    {editable && <th>Déclarer endom.</th>}
                  </tr>
                </thead>
                <tbody>
                  {(view.lines ?? []).map((l) => (
                    <tr key={l.receivingProductId ?? `${l.sku}-${l.reference}`}>
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
                            l.result === 'CONFIRMED'
                              ? 'os-tag--ok'
                              : l.result === 'PENDING'
                                ? 'os-tag--info'
                                : 'os-tag--err'
                          }`}
                        >
                          {RESULT_FR[l.result] ?? l.result}
                        </span>
                      </td>
                      {editable && (
                        <td>
                          <div className="rr-damage">
                            <input
                              type="number"
                              min={1}
                              placeholder="Qté"
                              value={damageQty[l.receivingProductId ?? ''] ?? ''}
                              onChange={(e) =>
                                setDamageQty((m) => ({ ...m, [l.receivingProductId ?? '']: e.target.value }))
                              }
                            />
                            <input
                              type="text"
                              placeholder="Note"
                              value={damageNote[l.receivingProductId ?? ''] ?? ''}
                              onChange={(e) =>
                                setDamageNote((m) => ({ ...m, [l.receivingProductId ?? '']: e.target.value }))
                              }
                            />
                            <button
                              type="button"
                              className="os-btn"
                              disabled={busy}
                              onClick={() => void declareDamage(l.receivingProductId)}
                            >
                              OK
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                  {(view.lines ?? []).length === 0 && (
                    <tr>
                      <td colSpan={editable ? 9 : 8} className="os-empty">
                        Aucune ligne produit.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Constats manuels</h2>
            <label className="rr-field">
              Description
              <textarea
                rows={2}
                value={description}
                disabled={!editable || busy}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optionnel)"
              />
            </label>
            <label className="rr-field">
              Observation / Commentaire
              <textarea
                rows={2}
                value={observation}
                disabled={!editable || busy}
                onChange={(e) => setObservation(e.target.value)}
                placeholder="Observation (optionnel)"
              />
            </label>
            <div className="rr-photos">
              {photos.map((p, i) => (
                <figure key={i} className="rr-photo">
                  <img src={p.dataUrl} alt={p.caption ?? `photo ${i + 1}`} />
                  {editable && (
                    <button
                      type="button"
                      className="ac-linkbtn"
                      onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                    >
                      retirer
                    </button>
                  )}
                </figure>
              ))}
            </div>
            {editable && (
              <div className="os-row">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => void onFiles(e.target.files)}
                />
                <button type="button" className="os-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                  📷 AJOUTER PHOTO
                </button>
              </div>
            )}
          </section>

          {editable && (
            <div className="os-row rr-actions">
              <button type="button" className="os-btn" disabled={busy} onClick={() => void saveDraft()}>
                ENREGISTRER BROUILLON
              </button>
              <button
                type="button"
                className="os-btn os-btn--primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                ✅ CONFIRMER ET ENVOYER
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
