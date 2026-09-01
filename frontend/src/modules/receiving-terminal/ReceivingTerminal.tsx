import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ReceivingArrival, type ReceivingSessionDetail } from '../receiving/api';
import { useAuth } from '../../context/AuthContext';
import ScanField from './ScanField';
import { detectCapabilities, freshOperationId, sourceLabel, type ScanSource } from './scan-source';
import './terminal.css';

const STATUS_TAG: Record<string, string> = {
  RECEIVING: 'accent',
  PAUSED: 'yellow',
  COMPLETED: 'green',
  COMPLETED_WITH_DISCREPANCY: 'red',
  CANCELLED: 'gray',
};

const PRODUCT_STATUS_TAG: Record<string, string> = {
  EXPECTED: 'gray',
  PARTIALLY_RECEIVED: 'yellow',
  RECEIVED: 'green',
  SHORT: 'red',
  OVERAGE: 'red',
  UNEXPECTED: 'red',
  NEEDS_REVIEW: 'yellow',
};

interface Activity {
  t: string;
  text: string;
  kind: 'ok' | 'warn' | 'info';
}

function codeTypeFor(source: ScanSource): 'QR' | 'BARCODE' | 'MANUAL' {
  return source === 'CAMERA' ? 'QR' : source === 'EXTERNAL_SCANNER' ? 'BARCODE' : 'MANUAL';
}

export default function ReceivingTerminal() {
  const { me, hasPermission } = useAuth();
  const canResolve = hasPermission('receiving.resolve_discrepancy');
  const caps = useMemo(() => detectCapabilities(), []);

  const [arrivals, setArrivals] = useState<ReceivingArrival[]>([]);
  const [session, setSession] = useState<ReceivingSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);
  const [pendingCarton, setPendingCarton] = useState<any | null>(null);
  const [lastSource, setLastSource] = useState<ScanSource>('EXTERNAL_SCANNER');
  const [activity, setActivity] = useState<Activity[]>([]);

  const loadArrivals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setArrivals(await api.arrivals());
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to load arrivals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadArrivals(); }, [loadArrivals]);

  // Network monitor: preserve the session across interruptions; never submit
  // duplicates (server idempotency via operationId handles re-connects).
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  // ----- helpers -----
  const apply = useCallback((next: ReceivingSessionDetail) => {
    setSession(next);
    setPendingCarton(next.flash?.kind === 'CARTON_IDENTIFIED' ? next.flash.carton : null);
    seedActivity(next);
    api.arrivals().then(setArrivals).catch(() => {});
  }, []);

  const seedActivity = useCallback((s: ReceivingSessionDetail) => {
    const rows: Activity[] = [];
    (s.receivedCartonEvents ?? []).forEach((c) => {
      rows.unshift({ t: c.receivedAt ? new Date(c.receivedAt).toLocaleTimeString() : '—', text: `Carton ${c.code} received`, kind: 'ok' });
    });
    (s.discrepancies ?? []).slice(0, 8).forEach((d) => {
      rows.unshift({ t: '', text: `${d.type.replace(/_/g, ' ')} — ${d.reason ?? ''}`, kind: 'warn' });
    });
    rows.sort((a, b) => (a.t < b.t ? 1 : -1));
    setActivity(rows.slice(0, 40));
  }, []);

  const pushActivity = useCallback((text: string, kind: Activity['kind']) => {
    setActivity((a) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...a].slice(0, 60));
  }, []);

  const guard = useCallback(async (fn: () => Promise<ReceivingSessionDetail>, okMsg?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      apply(next);
      if (okMsg) pushActivity(okMsg, 'ok');
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'Action failed.';
      setError(Array.isArray(m) ? m.join(', ') : m);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, apply, pushActivity]);

  // ----- actions -----
  async function openArrival(a: ReceivingArrival) {
    setError(null);
    setBusy(true);
    try {
      const active = await api.active(a.code);
      const exists = !!active;
      const started = exists ? active : await api.start(a.code, {
        deviceType: caps.deviceType,
        deviceName: caps.touch ? `${caps.deviceType}` : caps.userAgent.slice(0, 80),
        scanSource: caps.cameraScanningSupported ? 'CAMERA' : 'EXTERNAL_SCANNER',
      });
      apply(started);
      pushActivity(`Session ${started.code} ${exists ? 'resumed' : 'started'}`, 'info');
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Could not open receiving.');
    } finally {
      setBusy(false);
    }
  }

  async function onCartonSubmit(value: string, source: ScanSource) {
    if (!session) return;
    setLastSource(source);
    await guard(async () => {
      const r = await api.scanCarton(session.id, value, codeTypeFor(source), freshOperationId(), source);
      pushActivity(`Scanned carton ${value}`, 'info');
      return r;
    });
  }

  async function onConfirmCarton() {
    if (!session || !pendingCarton) return;
    const op = freshOperationId();
    await guard(async () => {
      const r = await api.receiveCarton(
        session.id,
        pendingCarton.externalCartonId ?? pendingCarton.id,
        op,
        lastSource,
      );
      setPendingCarton(null);
      pushActivity(`Carton ${pendingCarton.externalCartonId} confirmed`, 'ok');
      return r;
    });
  }

  async function onProductSubmit(value: string, source: ScanSource, qty: number) {
    if (!session) return;
    setLastSource(source);
    await guard(async () => {
      const r = await api.receiveProduct(session.id, value, qty, source, freshOperationId());
      pushActivity(`SKU ${value} ×${qty}`, 'ok');
      return r;
    });
  }

  async function onPause() {
    if (!session) return;
    const r = await api.pause(session.id);
    apply(r);
    pushActivity('Session paused', 'info');
  }
  async function onResume() {
    if (!session) return;
    const r = await api.resume(session.id);
    apply(r);
    pushActivity('Session resumed', 'info');
  }
  async function onComplete() {
    if (!session) return;
    await guard(async () => {
      const r = await api.complete(session.id);
      pushActivity('Receiving completed', 'ok');
      return r;
    });
  }
  async function onResolveDiscrepancy(id: string) {
    if (!session) return;
    await guard(async () => {
      const r = await api.resolve(id, 'Resolved by supervisor');
      pushActivity('Discrepancy resolved', 'ok');
      return r;
    });
  }

  // ----- derived -----
  const finished = session && (session.status === 'COMPLETED' || session.status === 'COMPLETED_WITH_DISCREPANCY');
  const t = session?.tally;
  const openDiscrepancies = (session?.discrepancies ?? []).filter((d) => d.status === 'OPEN');
  const flash = session?.flash;
  const lastWarn = flash && ['UNKNOWN_CARTON', 'WRONG_SHIPMENT', 'DUPLICATE_CARTON', 'UNEXPECTED_PRODUCT'].includes(flash.kind) ? flash : null;

  // next expected carton (not yet received)
  const receivedCartonIds = useMemo(() => new Set((session?.receivedCartonEvents ?? []).map((c) => c.cartonId)), [session]);
  const nextCarton = useMemo(() => {
    if (!session) return null;
    return (session.cartons ?? []).find((c) => c.status !== 'RECEIVED' && !receivedCartonIds.has(c.externalCartonId)) ?? null;
  }, [session, receivedCartonIds]);

  const currentCarton = pendingCarton ?? nextCarton;
  const paused = session?.status === 'PAUSED';

  // ---- render: arrivals picker ----
  if (!session) {
    return (
      <div className="rt">
        <header className="rt-header">
          <div className="rt-brand">
            <span className="rt-title">RECEIVING TERMINAL</span>
            <span className="rt-sub">AYROVI Warehouse · Carton-first inbound receiving</span>
          </div>
          <div className="rt-header-right">
            <span className={`rt-chip ${online ? 'ok' : 'bad'}`}>{online ? '● ONLINE' : '● OFFLINE'}</span>
          </div>
        </header>

        <div className="rt-body rt-picker">
          <div className="rt-section-head">
            <span className="rt-section-title">OPEN RECEIVING</span>
            <span className="muted">Select an expected arrival to start or resume its receiving session.</span>
          </div>
          {error && <div className="error-box">{error}</div>}
          {loading ? (
            <div className="empty"><span className="spinner" /></div>
          ) : arrivals.length === 0 ? (
            <div className="empty">No arrivals awaiting receiving. Push a Customer Arrival + Shipment card via the Arrival CRM.</div>
          ) : (
            <div className="rt-arrival-table-wrap">
              <table className="rt-table">
                <thead>
                  <tr>
                    <th>Arrival</th><th>Customer</th><th>Store</th><th>Status</th>
                    <th>Carrier</th><th>Tracking</th><th>Cartons</th><th>Units</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {arrivals.map((a) => (
                    <tr key={a.id} className="rt-row">
                      <td><strong>{a.code}</strong></td>
                      <td>{a.customerName}</td>
                      <td>{a.storeName ?? '—'}</td>
                      <td><span className={`tag ${a.status === 'EXPECTED' ? 'yellow' : 'accent'}`}>{a.status}</span></td>
                      <td>{a.carrier ?? '—'}</td>
                      <td className="mono">{a.tracking ?? '—'}</td>
                      <td>{a.cartons}</td>
                      <td>{a.units}</td>
                      <td className="rt-row-actions">
                        <button className="rcv-btn rcv-btn--primary" disabled={busy} onClick={() => openArrival(a)}>
                          {a.status === 'EXPECTED' ? '▶ Start receiving' : '⟳ Resume'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- render: operational terminal ----
  return (
    <div className="rt">
      {/* Terminal header (always visible) */}
      <header className="rt-header">
        <div className="rt-brand">
          <span className="rt-title">RECEIVING TERMINAL</span>
          <span className="rt-sub">Session {session.code} · {session.arrival.code}</span>
        </div>
        <div className="rt-worker">
          <div className="rt-worker-line">
            <span className="rt-worker-name">{me?.user.name ?? '—'}</span>
            <span className="rt-worker-role">{(me?.roles ?? []).join(', ') || 'Worker'}</span>
          </div>
          <span className={`rt-chip ${session.status === 'RECEIVING' ? 'ok' : session.status === 'PAUSED' ? 'warn' : session.status.startsWith('COMPLETED') ? 'ok' : 'bad'}`}>
            ● {session.status.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="rt-header-right">
          <span className="rt-chip">{caps.deviceType}</span>
          <span className={`rt-chip ${online ? 'ok' : 'bad'}`}>{online ? '● ONLINE' : '● OFFLINE'}</span>
          {!finished && (
            <>
              {paused ? (
                <button className="rcv-btn rcv-btn--ghost" disabled={busy} onClick={onResume}>▶ Resume</button>
              ) : (
                <button className="rcv-btn rcv-btn--ghost" disabled={busy} onClick={onPause}>⏸ Pause</button>
              )}
            </>
          )}
          <button className="rcv-btn rcv-btn--ghost rcv-btn--danger" onClick={() => { setSession(null); setPendingCarton(null); setActivity([]); loadArrivals(); }}>
            ✕ Exit
          </button>
        </div>
      </header>

      <div className="rt-body rt-terminal">
        {error && <div className="error-box">{error}</div>}
        {!online && <div className="net-banner">Connection lost — the session is preserved. Scans are idempotent and will not be duplicated on reconnection.</div>}

        {/* Operational status / warnings (persistent, never a disappearing toast) */}
        {(lastWarn || openDiscrepancies.length > 0) && (
          <div className="rt-warnbar">
            {lastWarn && <span className="rt-warn">{warnText(lastWarn)}</span>}
            {openDiscrepancies.length > 0 && (
              <span className="rt-warn rt-warn--count">{openDiscrepancies.length} open discrepancy{openDiscrepancies.length > 1 ? 'ies' : ''}</span>
            )}
          </div>
        )}

        {/* Shipment + Customer arrival */}
        <div className="rt-grid rt-grid--2">
          <InfoCard title="SHIPMENT">
            <K v="Shipment" c={session.shipment?.code ?? '—'} />
            <K v="External ID" c={session.shipment?.externalShipmentId ?? '—'} />
            <K v="Carrier" c={session.shipment?.carrierName ?? '—'} />
            <K v="Tracking" c={session.shipment?.trackingNumber ?? '—'} mono />
            <K v="Sender" c={session.shipment?.senderName ?? session.shipment?.senderCompany ?? '—'} />
            <K v="Expected cartons" c={String(t?.expectedCartons ?? 0)} />
          </InfoCard>
          <InfoCard title="CUSTOMER ARRIVAL">
            <K v="Arrival" c={session.arrival.code} />
            <K v="Customer" c={session.arrival.customerName} />
            <K v="Store" c={session.arrival.storeName ?? '—'} />
            <K v="Expected products" c={String(t?.expectedProducts ?? 0)} />
            <K v="Expected units" c={String(t?.expectedUnits ?? 0)} />
            <K v="Expected data" c="READ-ONLY" />
          </InfoCard>
        </div>

        {/* Carton scanner */}
        {!finished && (
          <div className="rt-panel rt-panel--scan">
            <ScanField
              label="SCAN CARTON"
              placeholder="Scan carton label (CTN-…), or type and press Enter"
              hint="Accepting QR · barcode · external scanner · manual"
              disabled={busy || paused}
              cameraLabel="Scan carton label"
              onSubmit={onCartonSubmit}
              sourceLabel={sourceLabel(lastSource)}
            />
            {flash?.kind === 'CARTON_IDENTIFIED' && (
              <div className="rt-identify rt-identify--ok">
                ✓ CARTOON IDENTIFIED — confirm receipt to record the physical carton.
              </div>
            )}
          </div>
        )}

        {/* Current carton + progress */}
        <div className="rt-grid rt-grid--2 rt-grid--current">
          <div className="rt-panel">
            <div className="rt-panel-title">CURRENT CARTON</div>
            {currentCarton ? (
              <>
                <div className="rt-cartonnum">{currentCarton.externalCartonId}</div>
                <div className="rt-cartondetail">Box {currentCarton.cartonNumber} / {currentCarton.totalCartons}</div>
                <div className="rt-kv-grid">
                  <K v="Status" c={pendingCarton ? 'IDENTIFIED — AWAIT CONFIRM' : currentCarton.status ?? 'EXPECTED'} />
                  {currentCarton.weight != null && <K v="Weight" c={`${currentCarton.weight} ${currentCarton.weightUnit ?? 'kg'}`} />}
                  <K v="Shipment" c={session.shipment?.code ?? '—'} />
                  <K v="Customer" c={session.arrival.customerName} />
                </div>
                {pendingCarton ? (
                  <button className="rcv-btn rcv-btn--ok rcv-btn--block" disabled={busy || paused} onClick={onConfirmCarton}>
                    ✓ CONFIRM CARTON RECEIVED
                  </button>
                ) : (
                  <div className="rt-scanhint">Scan the carton above to begin its receipt.</div>
                )}
              </>
            ) : (
              <div className="rt-cartonnum">—</div>
            )}
          </div>

          <div className="rt-panel">
            <div className="rt-panel-title">RECEIVING PROGRESS</div>
            <div className="rt-progress">
              <Progress label="CARTONS" value={`${t?.receivedCartons ?? 0} / ${t?.expectedCartons ?? 0}`} done={(t?.receivedCartons ?? 0) >= (t?.expectedCartons ?? 0)} />
              <Progress label="PRODUCTS" value={`${t?.receivedProducts ?? 0} / ${t?.expectedProducts ?? 0}`} done={(t?.receivedProducts ?? 0) >= (t?.expectedProducts ?? 0)} />
              <Progress label="UNITS" value={`${t?.receivedUnits ?? 0} / ${t?.expectedUnits ?? 0}`} done={(t?.receivedUnits ?? 0) >= (t?.expectedUnits ?? 0)} />
              <Progress label="DISCREPANCIES" value={`${t?.openDiscrepancies ?? 0}`} bad={(t?.openDiscrepancies ?? 0) > 0} />
            </div>
          </div>
        </div>

        {/* Expected products */}
        <div className="rt-panel">
          <div className="rt-panel-title">EXPECTED PRODUCTS <span className="muted">(expected is immutable — receiving records actual only)</span></div>
          <div className="rt-table-wrap">
            <table className="rt-table">
              <thead>
                <tr><th>SKU / REF</th><th>PRODUCT</th><th>EXPECTED</th><th>RECEIVED</th><th>REMAINING</th><th>STATUS</th></tr>
              </thead>
              <tbody>
                {(session.products ?? []).map((p) => (
                  <tr key={p.id} className={p.status === 'RECEIVED' ? 'rt-row--done' : ''}>
                    <td className="mono">{p.sku ?? p.reference ?? <em className="muted">no sku</em>}</td>
                    <td>{p.productName ?? '—'}</td>
                    <td>{p.expected}</td>
                    <td className="rt-big">{p.received}</td>
                    <td>{p.remaining}</td>
                    <td><span className={`tag ${PRODUCT_STATUS_TAG[p.status] ?? 'gray'}`}>{p.status.replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
                {session.products.length === 0 && (
                  <tr><td colSpan={6} className="muted">No expected product lines for this arrival.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Product scanner */}
        <div className="rt-panel rt-panel--scan rt-panel--product">
          <ProductScanner onSubmit={onProductSubmit} disabled={busy || paused} lastSource={lastSource} flash={flash} />
          <div className="muted rt-legend">Matching is performed authoritatively on the Warehouse backend.</div>
        </div>

        {/* Activity + carton queue */}
        <div className="rt-grid rt-grid--2">
          <div className="rt-panel">
            <div className="rt-panel-title">ACTIVITY</div>
            <div className="rt-log">
              {activity.length === 0 && <div className="muted">No activity yet.</div>}
              {activity.map((a, i) => (
                <div className={`rt-log-item rt-log-item--${a.kind}`} key={i}>
                  <span className="rt-log-time">{a.t}</span>
                  <span className="rt-log-text">{a.text}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rt-panel">
            <div className="rt-panel-title">CARTONS</div>
            <div className="rt-queue">
              {(session.cartons ?? []).map((c) => {
                const received = c.status === 'RECEIVED' || receivedCartonIds.has(c.externalCartonId);
                const current = currentCarton?.externalCartonId === c.externalCartonId;
                return (
                  <div key={c.id} className={`rt-queue-item ${received ? 'done' : ''} ${current ? 'current' : ''}`}>
                    <span className="rt-queue-mark">{received ? '✓' : current ? '●' : '○'}</span>
                    <span className="mono">{c.externalCartonId}</span>
                    <span className="rt-queue-state">{received ? 'RECEIVED' : current ? 'CURRENT' : 'PENDING'}</span>
                  </div>
                );
              })}
              {session.cartons.length === 0 && <div className="muted">No cartons declared for this shipment.</div>}
            </div>
          </div>
        </div>

        {/* Reconciliation / completion */}
        <div className="rt-panel rt-panel--reconcile">
          <div className="rt-reconcile-head">
            <div className="rt-panel-title">RECONCILIATION</div>
            <span className={`tag ${openDiscrepancies.length > 0 || (t?.shortUnits ?? 0) > 0 || (t?.overageUnits ?? 0) > 0 || (t?.unexpectedProducts ?? 0) > 0 || (t?.missingCartons ?? 0) > 0 ? 'red' : 'green'}`}>
              {hasIssues(t) ? '⚠ HAS DISCREPANCIES' : '✓ ALL MATCH'}
            </span>
          </div>
          <div className="rt-reconcile-grid">
            <Reconcile k="Expected cartons" v={`${t?.expectedCartons ?? 0}`} />
            <Reconcile k="Received cartons" v={`${t?.receivedCartons ?? 0}`} ok={t?.receivedCartons === t?.expectedCartons} />
            <Reconcile k="Expected products" v={`${t?.expectedProducts ?? 0}`} />
            <Reconcile k="Received products" v={`${t?.receivedProducts ?? 0}`} ok={t?.receivedProducts === t?.expectedProducts} />
            <Reconcile k="Expected units" v={`${t?.expectedUnits ?? 0}`} />
            <Reconcile k="Received units" v={`${t?.receivedUnits ?? 0}`} ok={t?.receivedUnits === t?.expectedUnits} />
            <Reconcile k="Missing cartons" v={`${t?.missingCartons ?? 0}`} bad={(t?.missingCartons ?? 0) > 0} />
            <Reconcile k="Short units" v={`${t?.shortUnits ?? 0}`} bad={(t?.shortUnits ?? 0) > 0} />
            <Reconcile k="Overage units" v={`${t?.overageUnits ?? 0}`} bad={(t?.overageUnits ?? 0) > 0} />
            <Reconcile k="Unexpected products" v={`${t?.unexpectedProducts ?? 0}`} bad={(t?.unexpectedProducts ?? 0) > 0} />
            <Reconcile k="Open discrepancies" v={`${t?.openDiscrepancies ?? 0}`} bad={(t?.openDiscrepancies ?? 0) > 0} />
          </div>
          <div className="rt-reconcile-actions">
            {hasIssues(t) && (
              <>
                <div className="rt-warn rt-warn--count">RECEIVING HAS DISCREPANCIES</div>
                {openDiscrepancies.map((d) => (
                  <div key={d.id} className="rt-disc">
                    <span className={`tag red`}>{d.type.replace(/_/g, ' ')}</span>
                    <span className="muted">{d.reason ?? ''}</span>
                    {d.status === 'OPEN' && canResolve && (
                      <button className="rcv-btn rcv-btn--ghost" disabled={busy} onClick={() => onResolveDiscrepancy(d.id)}>Resolve</button>
                    )}
                  </div>
                ))}
              </>
            )}
            {!finished ? (
              <button
                className={`rcv-btn rcv-btn--block ${hasIssues(t) ? 'rcv-btn--danger' : 'rcv-btn--ok'}`}
                disabled={busy || paused}
                title={hasIssues(t) && !canResolve ? 'Resolve or review discrepancies (supervisor) to complete' : ''}
                onClick={onComplete}
              >
                {hasIssues(t) ? (canResolve ? '✓ COMPLETE RECEIVING WITH DISCREPANCIES' : '⛔ REQUEST SUPERVISOR') : '✓ COMPLETE RECEIVING'}
              </button>
            ) : (
              <div className={`rt-done ${session.status.startsWith('COMPLETED') && hasIssues(t) ? 'rt-done--disc' : ''}`}>
                {session.status === 'COMPLETED' ? '✓ RECEIVING COMPLETED — READY FOR NEXT WAREHOUSE OPERATION' : '⚠ RECEIVING COMPLETED WITH DISCREPANCY — resolved / flagged for supervisor'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- small presentational helpers ----------
function hasIssues(t?: any): boolean {
  return !!t && (t.openDiscrepancies > 0 || t.shortUnits > 0 || t.overageUnits > 0 || t.unexpectedProducts > 0 || t.missingCartons > 0);
}
function warnText(f: any): string {
  if (f.kind === 'UNKNOWN_CARTON') return `⚠ UNKNOWN CARTON — "${f.code}" is not part of any expected shipment. Flagged for review.`;
  if (f.kind === 'WRONG_SHIPMENT') return `⚠ WRONG SHIPMENT — carton ${f.carton} belongs to shipment ${f.shipment}. Do NOT receive.`;
  if (f.kind === 'DUPLICATE_CARTON') return `⚠ DUPLICATE CARTON — ${f.carton} already received (not counted again).`;
  if (f.kind === 'UNEXPECTED_PRODUCT') return `⚠ UNEXPECTED PRODUCT — ${f.sku} is not on the expected list. Recorded as discrepancy.`;
  return '';
}
function K({ v, c, mono }: { v: string; c: string; mono?: boolean }) {
  return <div className="rt-kv"><span className="rt-kv-k">{v}</span><span className={`rt-kv-c ${mono ? 'mono' : ''}`}>{c}</span></div>;
}
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rt-panel">
      <div className="rt-panel-title">{title}</div>
      <div className="rt-kv-grid">{children}</div>
    </div>
  );
}
function Progress({ label, value, done, bad }: { label: string; value: string; done?: boolean; bad?: boolean }) {
  return (
    <div className="rt-progress-item">
      <span className="rt-progress-label">{label}</span>
      <span className={`rt-progress-value ${done ? 'ok' : bad ? 'bad' : ''}`}>{value}</span>
    </div>
  );
}
function Reconcile({ k, v, ok, bad }: { k: string; v: string; ok?: boolean; bad?: boolean }) {
  return (
    <div className="rt-reconcile-item">
      <span className="rt-reconcile-k">{k}</span>
      <span className={`rt-reconcile-v ${ok ? 'ok' : bad ? 'bad' : ''}`}>{v}</span>
    </div>
  );
}

/** Product scanner: quantity + SKU, uses ScanField. */
function ProductScanner({
  onSubmit,
  disabled,
  lastSource,
  flash,
}: {
  onSubmit: (value: string, source: ScanSource, qty: number) => void;
  disabled?: boolean;
  lastSource: ScanSource;
  flash: any;
}) {
  const [qty, setQty] = useState(1);
  const handle = (value: string, source: ScanSource) => {
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    onSubmit(value, source, q);
    setQty(1);
  };
  return (
    <>
      <div className="rt-product-row">
        <input
          className="rt-qty"
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(parseInt(e.target.value, 10) || 1)}
          disabled={disabled}
          title="Quantity"
        />
        <div className="rt-product-scan">
          <ScanField
            label="SCAN PRODUCT"
            placeholder="Scan / enter SKU, barcode or reference"
            hint="Barcode · SKU · reference · manual"
            disabled={disabled}
            cameraLabel="Scan product label"
            onSubmit={handle}
            sourceLabel={sourceLabel(lastSource)}
          />
        </div>
      </div>
      {flash?.kind === 'PRODUCT_MATCH' && (
        <div className="rt-identify rt-identify--ok">✓ MATCH — {flash.sku}: {flash.received}/{flash.expected} received (remaining {Math.max(0, flash.expected - flash.received)})</div>
      )}
      {flash?.kind === 'UNEXPECTED_PRODUCT' && (
        <div className="rt-identify rt-identify--bad">⚠ UNEXPECTED PRODUCT — {flash.sku} recorded as discrepancy.</div>
      )}
    </>
  );
}
