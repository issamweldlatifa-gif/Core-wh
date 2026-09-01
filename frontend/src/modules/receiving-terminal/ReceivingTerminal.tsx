import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ReceivingArrival, type ReceivingSessionDetail } from '../receiving/api';
import { useAuth } from '../../context/AuthContext';
import ScanField from './ScanField';
import { detectCapabilities, freshOperationId, sourceLabel, type ScanSource } from './scan-source';
import './terminal.css';

const PRODUCT_STATUS_TAG: Record<string, string> = {
  EXPECTED: 'dim', PARTIALLY_RECEIVED: 'yellow', RECEIVED: 'green',
  SHORT: 'red', OVERAGE: 'red', UNEXPECTED: 'red', NEEDS_REVIEW: 'yellow',
};

interface Activity { t: string; text: string; kind: 'ok' | 'warn' | 'info'; }

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
    setLoading(true); setError(null);
    try { setArrivals(await api.arrivals()); }
    catch (e: any) { setError(e?.response?.data?.message ?? e?.message ?? 'Failed to load arrivals.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadArrivals(); }, [loadArrivals]);

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  const apply = useCallback((next: ReceivingSessionDetail) => {
    setSession(next);
    setPendingCarton(next.flash?.kind === 'CARTON_IDENTIFIED' ? next.flash.carton : null);
    api.arrivals().then(setArrivals).catch(() => {});
  }, []);

  const pushActivity = useCallback((text: string, kind: Activity['kind']) => {
    setActivity((a) => [{ t: new Date().toLocaleTimeString(), text, kind }, ...a].slice(0, 60));
  }, []);

  const guard = useCallback(async (fn: () => Promise<ReceivingSessionDetail>, okMsg?: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const next = await fn(); apply(next);
      if (okMsg) pushActivity(okMsg, 'ok');
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'Action failed.';
      setError(Array.isArray(m) ? m.join(', ') : m);
    } finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, apply, pushActivity]);

  async function openArrival(a: ReceivingArrival) {
    setError(null); setBusy(true);
    try {
      const active = await api.active(a.code);
      const exists = !!active;
      const started = exists ? active : await api.start(a.code, {
        deviceType: caps.deviceType,
        deviceName: caps.touch ? `${caps.deviceType}` : caps.userAgent.slice(0, 80),
        scanSource: caps.cameraScanningSupported ? 'CAMERA' : 'EXTERNAL_SCANNER',
      });
      apply(started);
      pushActivity(`session ${started.code} ${exists ? 'resumed' : 'started'}`, 'info');
    } catch (e: any) { setError(e?.response?.data?.message ?? e?.message ?? 'Could not open receiving.'); }
    finally { setBusy(false); }
  }

  async function onCartonSubmit(value: string, source: ScanSource) {
    if (!session) return;
    setLastSource(source);
    await guard(async () => {
      const r = await api.scanCarton(session.id, value, codeTypeFor(source), freshOperationId(), source);
      pushActivity(`scanned carton ${value}`, 'info');
      return r;
    });
  }

  async function onConfirmCarton() {
    if (!session || !pendingCarton) return;
    await guard(async () => {
      const r = await api.receiveCarton(session.id, pendingCarton.externalCartonId ?? pendingCarton.id, freshOperationId(), lastSource);
      setPendingCarton(null);
      pushActivity(`carton ${pendingCarton.externalCartonId} confirmed`, 'ok');
      return r;
    });
  }

  async function onProductSubmit(value: string, source: ScanSource, qty: number) {
    if (!session) return;
    setLastSource(source);
    await guard(async () => {
      const r = await api.receiveProduct(session.id, value, qty, source, freshOperationId());
      pushActivity(`sku ${value} x${qty}`, 'ok');
      return r;
    });
  }

  async function onPause() { if (session) { apply(await api.pause(session.id)); pushActivity('session paused', 'info'); } }
  async function onResume() { if (session) { apply(await api.resume(session.id)); pushActivity('session resumed', 'info'); } }
  async function onComplete() { if (session) await guard(async () => { const r = await api.complete(session.id); pushActivity('receiving completed', 'ok'); return r; }); }
  async function onResolveDiscrepancy(id: string) { if (session) await guard(async () => { const r = await api.resolve(id, 'Resolved by supervisor'); pushActivity('discrepancy resolved', 'ok'); return r; }); }

  const finished = session && (session.status === 'COMPLETED' || session.status === 'COMPLETED_WITH_DISCREPANCY');
  const t = session?.tally;
  const openDiscrepancies = (session?.discrepancies ?? []).filter((d) => d.status === 'OPEN');
  const flash = session?.flash;
  const lastWarn = flash && ['UNKNOWN_CARTON', 'WRONG_SHIPMENT', 'DUPLICATE_CARTON', 'UNEXPECTED_PRODUCT'].includes(flash.kind) ? flash : null;

  const receivedCartonIds = useMemo(() => new Set((session?.receivedCartonEvents ?? []).map((c) => c.cartonId)), [session]);
  const nextCarton = useMemo(() => {
    if (!session) return null;
    return (session.cartons ?? []).find((c) => c.status !== 'RECEIVED' && !receivedCartonIds.has(c.externalCartonId)) ?? null;
  }, [session, receivedCartonIds]);
  const currentCarton = pendingCarton ?? nextCarton;
  const paused = session?.status === 'PAUSED';
  const worker = me?.user?.name ?? 'worker';
  const host = worker.toLowerCase().replace(/\s+/g, '-') || 'worker';

  // ---------- PICKER ----------
  if (!session) {
    return (
      <div className="term">
        <div className="term-topbar">
          <span>AYROVI WAREHOUSE <span className="dim">· RECEIVING TERMINAL</span></span>
          <span className={`term-net ${online ? 'ok' : 'bad'}`}>{online ? '● ONLINE' : '● OFFLINE'}</span>
        </div>
        <div className="term-body">
          <div className="term-banner">
            <span className="green">**</span> AYROVI WAREHOUSE CORE — RECEIVING TERMINAL <span className="green">**</span>
            <div>select an expected arrival to start or resume its receiving session.</div>
          </div>
          {error && <div className="term-error">!! error: {error}</div>}
          {loading ? <div className="dim">loading arrivals…</div>
            : arrivals.length === 0 ? <div className="dim">no arrivals awaiting receiving. push a customer arrival + shipment card via the arrival crm.</div>
            : (
              <div className="term-table-wrap">
                <table className="term-table">
                  <thead><tr><th>ARRIVAL</th><th>CUSTOMER</th><th>STORE</th><th>STATUS</th><th>CARRIER</th><th>TRACKING</th><th>CTN</th><th>UNITS</th><th></th></tr></thead>
                  <tbody>
                    {arrivals.map((a) => (
                      <tr key={a.id} className="term-row">
                        <td className="green">{a.code}</td><td>{a.customerName}</td><td>{a.storeName ?? '—'}</td>
                        <td className={a.status === 'EXPECTED' ? 'yellow' : 'green'}>{a.status}</td>
                        <td>{a.carrier ?? '—'}</td><td className="dim">{a.tracking ?? '—'}</td>
                        <td>{a.cartons}</td><td>{a.units}</td>
                        <td className="right">
                          <button className="term-btn term-btn--link" disabled={busy} onClick={() => openArrival(a)}>
                            {a.status === 'EXPECTED' ? '[ start receiving ]' : '[ resume ]'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
        <div className="term-progressbar" />
      </div>
    );
  }

  // ---------- TERMINAL ----------
  const prompt = `${host}@warehouse:~$`;
  return (
    <div className="term">
      <div className="term-topbar">
        <span>AYROVI RECEIVING TERMINAL <span className="dim">· session {session.code}</span></span>
        <span className="term-user"><span className="green">{worker}</span> <span className="dim">[{me?.roles?.join(',') || 'worker'}]</span></span>
        <span className="term-chip">{caps.deviceType}</span>
        <span className={`term-net ${online ? 'ok' : 'bad'}`}>{online ? '● ONLINE' : '● OFFLINE'}</span>
        {!finished && (paused
          ? <button className="term-btn" disabled={busy} onClick={onResume}>[ resume ]</button>
          : <button className="term-btn" disabled={busy} onClick={onPause}>[ pause ]</button>)}
        <button className="term-btn term-btn--danger" onClick={() => { setSession(null); setPendingCarton(null); setActivity([]); loadArrivals(); }}>[ exit ]</button>
      </div>

      <div className="term-body">
        {error && <div className="term-error">!! error: {error}</div>}
        {!online && <div className="term-warn">-- connection lost: session preserved; scans idempotent, no duplicates on reconnect --</div>}
        {(lastWarn || openDiscrepancies.length > 0) && (
          <div className="term-warn">
            {lastWarn && <span>{warnText(lastWarn)}</span>}
            {openDiscrepancies.length > 0 && <span className="red"> [{openDiscrepancies.length} open discrepancies]</span>}
          </div>
        )}

        {/* Shipment + arrival */}
        <div className="term-grid2">
          <Box title="SHIPMENT">
            <Row k="shipment" v={session.shipment?.code ?? '—'} />
            <Row k="external id" v={session.shipment?.externalShipmentId ?? '—'} />
            <Row k="carrier" v={session.shipment?.carrierName ?? '—'} />
            <Row k="tracking" v={session.shipment?.trackingNumber ?? '—'} />
            <Row k="sender" v={session.shipment?.senderName ?? session.shipment?.senderCompany ?? '—'} />
            <Row k="expected cartons" v={String(t?.expectedCartons ?? 0)} />
          </Box>
          <Box title="CUSTOMER ARRIVAL">
            <Row k="arrival" v={session.arrival.code} />
            <Row k="customer" v={session.arrival.customerName} />
            <Row k="store" v={session.arrival.storeName ?? '—'} />
            <Row k="expected products" v={String(t?.expectedProducts ?? 0)} />
            <Row k="expected units" v={String(t?.expectedUnits ?? 0)} />
            <Row k="expected data" v="READ-ONLY" />
          </Box>
        </div>

        {/* Carton scan */}
        {!finished && (
          <div className="term-box term-box--accent">
            <ScanField
              label="SCAN CARTON"
              placeholder="scan carton label (CTN-...) or type + enter"
              hint="accepting: qr | barcode | external scanner | manual"
              disabled={busy || paused}
              cameraLabel="Scan carton label"
              onSubmit={onCartonSubmit}
              sourceLabel={sourceLabel(lastSource)}
            />
            {flash?.kind === 'CARTON_IDENTIFIED' && (
              <div className="term-ok">+ carton identified -- confirm receipt to record the physical carton</div>
            )}
          </div>
        )}

        {/* Current carton + progress */}
        <div className="term-grid2">
          <Box title="CURRENT CARTON">
            <div className="term-carton green">{currentCarton?.externalCartonId ?? '—'}</div>
            <div className="dim">box {currentCarton ? `${currentCarton.cartonNumber} / ${currentCarton.totalCartons}` : '—'}</div>
            <Row k="status" v={pendingCarton ? 'IDENTIFIED - AWAIT CONFIRM' : currentCarton?.status ?? 'EXPECTED'} />
            <Row k="shipment" v={session.shipment?.code ?? '—'} />
            <Row k="customer" v={session.arrival.customerName} />
            {currentCarton?.weight != null && <Row k="weight" v={`${currentCarton.weight} ${currentCarton.weightUnit ?? 'kg'}`} />}
            {pendingCarton ? (
              <button className="term-btn term-btn--ok term-btn--full" disabled={busy || paused} onClick={onConfirmCarton}>
                + CONFIRM CARTON RECEIVED
              </button>
            ) : (
              <div className="term-hint">scan a carton above to begin its receipt.</div>
            )}
          </Box>
          <Box title="RECEIVING PROGRESS">
            <Progress label="CARTONS" v={`${t?.receivedCartons ?? 0} / ${t?.expectedCartons ?? 0}`} ok={(t?.receivedCartons ?? 0) >= (t?.expectedCartons ?? 0)} />
            <Progress label="PRODUCTS" v={`${t?.receivedProducts ?? 0} / ${t?.expectedProducts ?? 0}`} ok={(t?.receivedProducts ?? 0) >= (t?.expectedProducts ?? 0)} />
            <Progress label="UNITS" v={`${t?.receivedUnits ?? 0} / ${t?.expectedUnits ?? 0}`} ok={(t?.receivedUnits ?? 0) >= (t?.expectedUnits ?? 0)} />
            <Progress label="DISCREPANCIES" v={`${t?.openDiscrepancies ?? 0}`} bad={(t?.openDiscrepancies ?? 0) > 0} />
          </Box>
        </div>

        {/* Expected products */}
        <Box title="EXPECTED PRODUCTS">
          <div className="dim">expected is immutable -- receiving records actual only</div>
          <div className="term-table-wrap">
            <table className="term-table">
              <thead><tr><th>SKU/REF</th><th>PRODUCT</th><th>EXPECTED</th><th>RECEIVED</th><th>REMAINING</th><th>STATUS</th></tr></thead>
              <tbody>
                {(session.products ?? []).map((p) => (
                  <tr key={p.id} className={p.status === 'RECEIVED' ? 'term-row--done' : ''}>
                    <td className="cyan">{p.sku ?? p.reference ?? <em className="dim">no sku</em>}</td>
                    <td>{p.productName ?? '—'}</td><td>{p.expected}</td>
                    <td className="green">{p.received}</td><td>{p.remaining}</td>
                    <td className={PRODUCT_STATUS_TAG[p.status] ?? 'dim'}>{p.status.replace(/_/g, ' ')}</td>
                  </tr>
                ))}
                {session.products.length === 0 && <tr><td colSpan={6} className="dim">no expected product lines for this arrival.</td></tr>}
              </tbody>
            </table>
          </div>
        </Box>

        {/* Product scan */}
        <Box title="SCAN PRODUCT">
          <ProductScanner onSubmit={onProductSubmit} disabled={busy || paused} lastSource={lastSource} flash={flash} />
          <div className="term-hint">matching is performed authoritatively on the warehouse backend.</div>
        </Box>

        {/* Activity + cartons */}
        <div className="term-grid2">
          <Box title="ACTIVITY">
            <div className="term-log">
              {activity.length === 0 && <div className="dim">no activity yet.</div>}
              {activity.map((a, i) => (
                <div key={i} className={`term-logitem term-logitem--${a.kind}`}>
                  <span className="dim">{a.t}</span> {a.text}
                </div>
              ))}
            </div>
          </Box>
          <Box title="CARTONS">
            <div className="term-queue">
              {(session.cartons ?? []).map((c) => {
                const rec = c.status === 'RECEIVED' || receivedCartonIds.has(c.externalCartonId);
                const cur = currentCarton?.externalCartonId === c.externalCartonId;
                return (
                  <div key={c.id} className={`term-qitem ${rec ? 'done' : ''} ${cur ? 'current' : ''}`}>
                    <span>{rec ? '[x]' : cur ? '[*]' : '[ ]'}</span>
                    <span className="cyan">{c.externalCartonId}</span>
                    <span className="right dim">{rec ? 'RECEIVED' : cur ? 'CURRENT' : 'PENDING'}</span>
                  </div>
                );
              })}
              {session.cartons.length === 0 && <div className="dim">no cartons declared.</div>}
            </div>
          </Box>
        </div>

        {/* Reconciliation */}
        <div className="term-box typewriter">
          <div className="term-boxtitle">RECONCILIATION <span className={hasIssues(t) ? 'red' : 'green'}>{hasIssues(t) ? '[! HAS DISCREPANCIES]' : '[! ALL MATCH]'}</span></div>
          <div className="term-recgrid">
            <Rec k="expected cartons" v={`${t?.expectedCartons ?? 0}`} />
            <Rec k="received cartons" v={`${t?.receivedCartons ?? 0}`} ok={t?.receivedCartons === t?.expectedCartons} />
            <Rec k="expected products" v={`${t?.expectedProducts ?? 0}`} />
            <Rec k="received products" v={`${t?.receivedProducts ?? 0}`} ok={t?.receivedProducts === t?.expectedProducts} />
            <Rec k="expected units" v={`${t?.expectedUnits ?? 0}`} />
            <Rec k="received units" v={`${t?.receivedUnits ?? 0}`} ok={t?.receivedUnits === t?.expectedUnits} />
            <Rec k="missing cartons" v={`${t?.missingCartons ?? 0}`} bad={(t?.missingCartons ?? 0) > 0} />
            <Rec k="short units" v={`${t?.shortUnits ?? 0}`} bad={(t?.shortUnits ?? 0) > 0} />
            <Rec k="overage units" v={`${t?.overageUnits ?? 0}`} bad={(t?.overageUnits ?? 0) > 0} />
            <Rec k="unexpected products" v={`${t?.unexpectedProducts ?? 0}`} bad={(t?.unexpectedProducts ?? 0) > 0} />
            <Rec k="open discrepancies" v={`${t?.openDiscrepancies ?? 0}`} bad={(t?.openDiscrepancies ?? 0) > 0} />
          </div>
          <div className="term-recactions">
            {hasIssues(t) && openDiscrepancies.map((d) => (
              <div key={d.id} className="term-disc">
                <span className="red">[{d.type.replace(/_/g, ' ')}]</span> <span className="dim">{d.reason ?? ''}</span>
                {d.status === 'OPEN' && canResolve && <button className="term-btn" disabled={busy} onClick={() => onResolveDiscrepancy(d.id)}>[ resolve ]</button>}
              </div>
            ))}
            {!finished ? (
              <button className={`term-btn term-btn--full ${hasIssues(t) ? 'term-btn--danger' : 'term-btn--ok'}`} disabled={busy || paused} onClick={onComplete}>
                {hasIssues(t) ? (canResolve ? "+ COMPLETE RECEIVING WITH DISCREPANCIES" : "! REQUEST SUPERVISOR") : "+ COMPLETE RECEIVING"}
              </button>
            ) : (
              <div className={session.status === 'COMPLETED' ? 'term-ok typewriter' : 'term-error typewriter'}>
                {session.status === 'COMPLETED' ? '+ receiving completed -- ready for next warehouse operation' : '! receiving completed with discrepancy -- flagged/resolved by supervisor'}
              </div>
            )}
          </div>
        </div>

        <div className="term-promptline">
          <span className="green">{prompt}</span><span className="term-blink">▊</span>
        </div>
      </div>
      <div className="term-progressbar" />
    </div>
  );
}

// ---------- presentational ----------
function hasIssues(t?: any): boolean {
  return !!t && (t.openDiscrepancies > 0 || t.shortUnits > 0 || t.overageUnits > 0 || t.unexpectedProducts > 0 || t.missingCartons > 0);
}
function warnText(f: any): string {
  if (f.kind === 'UNKNOWN_CARTON') return `! unknown carton "${f.code}" not on any expected shipment. flagged for review.`;
  if (f.kind === 'WRONG_SHIPMENT') return `! wrong shipment -- carton ${f.carton} belongs to shipment ${f.shipment}. do NOT receive.`;
  if (f.kind === 'DUPLICATE_CARTON') return `! duplicate carton -- ${f.carton} already received (not counted again).`;
  if (f.kind === 'UNEXPECTED_PRODUCT') return `! unexpected product -- ${f.sku} not on the expected list. recorded as discrepancy.`;
  return '';
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="term-rowkv"><span className="dim">{k.padEnd(18)}</span><span>{v}</span></div>;
}
function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="term-box">
      <div className="term-boxtitle">&gt; {title}</div>
      {children}
    </div>
  );
}
function Progress({ label, v, ok, bad }: { label: string; v: string; ok?: boolean; bad?: boolean }) {
  return <div className="term-progitem"><span className="dim">{label.padEnd(14)}</span><span className={ok ? 'green' : bad ? 'red' : ''}>{v}</span></div>;
}
function Rec({ k, v, ok, bad }: { k: string; v: string; ok?: boolean; bad?: boolean }) {
  return <div className="term-recitem"><span className="dim">{k}</span><span className={ok ? 'green' : bad ? 'red' : ''}>{v}</span></div>;
}
function ProductScanner({ onSubmit, disabled, lastSource, flash }: {
  onSubmit: (v: string, s: ScanSource, qty: number) => void; disabled?: boolean; lastSource: ScanSource; flash: any;
}) {
  const [qty, setQty] = useState(1);
  const handle = (v: string, s: ScanSource) => { onSubmit(v, s, Math.max(1, Math.floor(Number(qty) || 1))); setQty(1); };
  return (
    <>
      <div className="term-field-row term-carton-qty">
        <span className="term-caret">$</span>
        <input className="term-input term-qty" type="number" min={1} value={qty} onChange={(e) => setQty(parseInt(e.target.value, 10) || 1)} disabled={disabled} />
        <span className="dim">quantity per scan</span>
      </div>
      <ScanField
        label="SCAN PRODUCT"
        placeholder="scan / enter sku, barcode or reference"
        hint="barcode | sku | reference | manual"
        disabled={disabled}
        cameraLabel="Scan product label"
        onSubmit={handle}
        sourceLabel={sourceLabel(lastSource)}
      />
      {flash?.kind === 'PRODUCT_MATCH' && (
        <div className="term-ok">+ match -- {flash.sku}: {flash.received}/{flash.expected} received (remaining {Math.max(0, flash.expected - flash.received)})</div>
      )}
      {flash?.kind === 'UNEXPECTED_PRODUCT' && (
        <div className="term-error">! unexpected product -- {flash.sku} recorded as discrepancy.</div>
      )}
    </>
  );
}
