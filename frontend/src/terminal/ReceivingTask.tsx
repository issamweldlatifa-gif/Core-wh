import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ReceivingArrival, type ReceivingSessionDetail, type ReceivingProduct, type ReceivingDiscrepancy } from '../modules/receiving/api';
import { detectCapabilities, freshOperationId, type ScanSource } from '../modules/receiving-terminal/scan-source';
import { beepSuccess, beepError, beepInfo, beepDone } from '../modules/receiving-terminal/feedback';
import { cleanCode } from '../modules/receiving-terminal/validate';
import { buildScanContext, type ScanContext } from '../modules/receiving-terminal/scan-context';
import { stationHas } from './api';
import { useTerminalUi } from './WorkerShell';
import { fulfillmentApi, type OpContainer } from './fulfillment-api';
import { printLabel } from './print-label';
import { attachHidScanner } from '../modules/receiving-terminal/hardware-wedge';
import './receiving-task.css';

const ReceivingScanner = lazy(() => import('../modules/receiving-terminal/ReceivingScanner'));

type ViewState = 'ARRIVALS' | 'HOME' | 'SCANNER_CAMERA' | 'MANUAL_ENTRY' | 'PRODUCT_RESULT';

export default function ReceivingTask() {
  const { ctx, setStatus, setLastAction } = useTerminalUi();
  const caps = useMemo(() => detectCapabilities(), []);
  const ocrAllowed = stationHas(ctx?.station ?? null, 'OCR');

  const [arrivals, setArrivals] = useState<ReceivingArrival[]>([]);
  const [session, setSession] = useState<ReceivingSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewState>('ARRIVALS');
  const [scanMode, setScanMode] = useState<'CARTON' | 'PRODUCT'>('CARTON');
  
  // Product Result State
  const [scannedCode, setScannedCode] = useState<string>('');
  const [matchedProduct, setMatchedProduct] = useState<ReceivingProduct | null>(null);
  const [qty, setQty] = useState<number>(1);
  const [flashMsg, setFlashMsg] = useState<{ kind: 'ok'|'bad'|'warn'; text: string } | null>(null);

  // Manual Entry State
  const [manualCode, setManualCode] = useState<string>('');

  // Totes
  const [tote, setTote] = useState<OpContainer | null>(null);
  const [totes, setTotes] = useState<OpContainer[]>([]);

  const refreshTotes = useCallback(async () => {
    try { setTotes(await fulfillmentApi.containers({ type: 'RECEIVING', status: 'ACTIVE' })); } catch { }
  }, []);
  useEffect(() => { void refreshTotes(); }, [refreshTotes]);

  const loadArrivals = useCallback(async () => {
    setLoading(true);
    try {
      setArrivals(await api.arrivals());
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadArrivals(); }, [loadArrivals]);

  // Resume active session
  useEffect(() => {
    const active = ctx?.activeSession;
    if (!active || session) return;
    api.session(active.id).then(s => {
      setSession(s);
      setView('HOME');
    }).catch(() => {});
  }, [ctx, session]);

  const openArrival = async (a: ReceivingArrival) => {
    setBusy(true);
    try {
      const existing = await api.active(a.code);
      const s = existing ?? await api.start(a.code, {
        deviceType: caps.deviceType,
        deviceName: caps.userAgent.slice(0, 80),
        scanSource: caps.cameraScanningSupported ? 'CAMERA' : 'EXTERNAL_SCANNER',
      });
      setSession(s);
      setView('HOME');
      setStatus({ text: 'SESSION ACTIVE', kind: 'info' });
    } catch (e: any) {
      setFlashMsg({ kind: 'bad', text: e?.response?.data?.message ?? 'Could not start receiving.' });
    } finally {
      setBusy(false);
    }
  };

  const processScan = async (rawCode: string, source: ScanSource) => {
    if (!session || view === 'PRODUCT_RESULT' || busy) return;
    const value = rawCode.trim();
    if (!value) return;

    if (scanMode === 'CARTON') {
      setBusy(true);
      try {
        const s = await api.scanCarton(session.id, value, source === 'CAMERA' ? 'QR' : 'BARCODE', freshOperationId(), source);
        setSession(s);
        const f = s.flash;
        if (f?.kind === 'CARTON_IDENTIFIED') {
          const cartonId = f.carton?.externalCartonId ?? f.carton?.id;
          const committed = await api.receiveCarton(s.id, cartonId, freshOperationId(), source);
          setSession(committed);
          beepSuccess();
          setFlashMsg({ kind: 'ok', text: `CARTON RECEIVED: ${cartonId}` });
          setScanMode('PRODUCT'); // Switch to product automatically!
          setLastAction(`Carton ${cartonId} received`);
        } else {
          beepError();
          setFlashMsg({ kind: 'bad', text: f?.kind === 'UNKNOWN_CARTON' ? 'UNKNOWN CARTON' : f?.kind === 'DUPLICATE_CARTON' ? 'ALREADY RECEIVED' : 'NOT ACCEPTED' });
        }
      } catch (e: any) {
        beepError();
        setFlashMsg({ kind: 'bad', text: e?.response?.data?.message ?? 'Server error' });
      } finally {
        setBusy(false);
      }
    } else {
      // PRODUCT MODE
      beepInfo();
      const clean = cleanCode(value);
      const product = session.products.find(p => cleanCode(p.sku ?? '') === clean || cleanCode(p.reference ?? '') === clean);
      
      setScannedCode(value);
      setMatchedProduct(product ?? null);
      setQty(1);
      setFlashMsg(null);
      setView('PRODUCT_RESULT');
    }
  };

  // Attach Hardware Wedge globally when session is active
  useEffect(() => {
    if (!session || view === 'PRODUCT_RESULT' || view === 'SCANNER_CAMERA') return;
    const detach = attachHidScanner(
      { onRead: (e) => processScan(e.value, 'EXTERNAL_SCANNER') },
      { terminatorKeys: ['Enter'], maxLength: 64 }
    );
    return detach;
  }, [session, view, processScan]);

  const confirmReceiving = async () => {
    if (!session || !scannedCode || busy) return;
    setBusy(true);
    setStatus({ text: 'SUBMITTING', kind: 'info' });
    try {
      if (tote) {
        let lastFlash: any = null;
        for (let i = 0; i < qty; i++) {
          const res = await fulfillmentApi.scanArticle(session.id, {
            sku: scannedCode,
            containerCode: tote.code,
          });
          lastFlash = res.flash;
        }
        const s = await api.session(session.id);
        setSession(s);
        beepSuccess();
        setLastAction(`Received x${qty} of ${scannedCode} into ${tote.code}`);
      } else {
        const s = await api.receiveProduct(session.id, scannedCode, qty, 'MANUAL', freshOperationId());
        setSession(s);
        beepSuccess();
        setLastAction(`Received x${qty} of ${scannedCode}`);
      }
      
      // Auto-return to HOME for next scan (SPEED PRIORITY)
      setView('HOME');
      setStatus({ text: 'READY FOR NEXT SCAN', kind: 'ok' });
      setFlashMsg(null);
    } catch (e: any) {
      beepError();
      const m = e?.response?.data?.message ?? 'Server error';
      setFlashMsg({ kind: 'bad', text: Array.isArray(m) ? m.join(', ') : String(m) });
      setStatus({ text: 'ERROR', kind: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  const scanContext: ScanContext = useMemo(
    () => buildScanContext({ mode: scanMode, cartons: session?.cartons ?? [], products: session?.products ?? [] }),
    [session, scanMode]
  );

  const corpus = useMemo(() => {
    const out = new Set<string>();
    if (scanMode === 'CARTON') {
      for (const c of session?.cartons ?? []) {
        const id = cleanCode(c.externalCartonId ?? ''); if(id.length>2) out.add(id);
        const ref = cleanCode(c.reference ?? ''); if(ref.length>2) out.add(ref);
        const qr = cleanCode(c.qrCodeValue ?? ''); if(qr.length>2) out.add(qr);
        const bar = cleanCode(c.barcodeValue ?? ''); if(bar.length>2) out.add(bar);
      }
    } else {
      for (const p of session?.products ?? []) {
        const s = cleanCode(p.sku ?? ''); if(s.length>2) out.add(s);
        const r = cleanCode(p.reference ?? ''); if(r.length>2) out.add(r);
      }
    }
    return [...out];
  }, [session, scanMode]);

  const goHome = () => setView('HOME');

  // Renders
  if (!session || view === 'ARRIVALS') {
    return (
      <div className="term-container">
        <div className="term-header">
          <div className="term-header-title">AYROVI RECEIVING</div>
          <div className="term-status-online">ONLINE</div>
        </div>
        <div className="term-home-arrivals">
          {flashMsg && <div className={`term-flash-msg ${flashMsg.kind}`}>{flashMsg.text}</div>}
          <div className="term-section-title">SELECT ARRIVAL</div>
          {arrivals.map(a => (
            <div key={a.id} className="term-arrival-card" onClick={() => openArrival(a)}>
              <div style={{fontWeight: 'bold', fontSize: '1.2rem'}}>{a.code}</div>
              <div className="term-muted">{a.customerName} · {a.status}</div>
              <div>{a.products} Products · {a.units} Units</div>
            </div>
          ))}
          {!loading && arrivals.length === 0 && <div className="term-muted">No pending arrivals.</div>}
        </div>
      </div>
    );
  }

  const tally = session.tally;
  const recentProducts = session.products.filter(p => p.received > 0).slice(0, 3);
  const openExceptions = session.discrepancies.filter(d => d.status === 'OPEN');

  return (
    <div className="term-container">
      <div className="term-header">
        <div className="term-header-title">AYROVI RECEIVING</div>
        <div className="term-status-online">ONLINE</div>
      </div>

      {view === 'HOME' && (
        <>
          <div className="term-session-info">
            <div className="term-session-id">{session.code}</div>
            <div className="term-customer">
              <div>{session.arrival.customerName}</div>
              {session.arrival.storeName && <div>{session.arrival.storeName}</div>}
            </div>
          </div>

          <div className="term-metrics">
            <div className="term-metric">
              <span className="term-metric-label">EXPECTED</span>
              <span className="term-metric-value">{tally.expectedProducts}</span>
            </div>
            <div className="term-metric success">
              <span className="term-metric-label">RECEIVED</span>
              <span className="term-metric-value">{tally.receivedProducts}</span>
            </div>
            <div className={`term-metric ${openExceptions.length > 0 ? 'danger' : ''}`}>
              <span className="term-metric-label">EXCEPTIONS</span>
              <span className="term-metric-value">{openExceptions.length}</span>
            </div>
          </div>

          
          <div style={{ display: 'flex', gap: '8px', padding: '16px 16px 0' }}>
            <button 
              style={{ flex: 1, padding: '12px', background: scanMode === 'PRODUCT' ? 'var(--term-green)' : 'var(--term-surface-2)', color: scanMode === 'PRODUCT' ? '#000' : 'var(--term-text)', border: 'none', fontWeight: 'bold' }}
              onClick={() => setScanMode('PRODUCT')}
            >SCAN PRODUCT</button>
            <button 
              style={{ flex: 1, padding: '12px', background: scanMode === 'CARTON' ? 'var(--term-green)' : 'var(--term-surface-2)', color: scanMode === 'CARTON' ? '#000' : 'var(--term-text)', border: 'none', fontWeight: 'bold' }}
              onClick={() => setScanMode('CARTON')}
            >SCAN CARTON</button>
          </div>

          <div className="term-primary-action">
            <button className="term-btn-scan" onClick={() => setView('SCANNER_CAMERA')}>
              + SCAN {scanMode}
            </button>
            <div className="term-hw-status ready">SCANNER CT40 SIDE TRIGGER READY</div>
          </div>

          <div style={{display: 'flex', gap: '8px', padding: '0 16px', marginBottom: '16px'}}>
            <button className="term-btn-secondary" onClick={() => setView('MANUAL_ENTRY')}>ENTER CODE</button>
          </div>

          {openExceptions.length > 0 && (
            <div className="term-section">
              <div className="term-section-title">EXCEPTIONS</div>
              {openExceptions.map(d => (
                <div key={d.id} className="term-exception-row">
                  <div className="term-exception-info">
                    <div className="term-exception-title">{d.type.replace(/_/g, ' ')}</div>
                    <div className="term-exception-sku">SKU: {d.reason ?? d.sku ?? d.cartonCode ?? 'UNKNOWN'}</div>
                  </div>
                  <button className="term-btn-review">REVIEW</button>
                </div>
              ))}
            </div>
          )}

          {recentProducts.length > 0 && (
            <div className="term-section">
              <div className="term-section-title">RECENT PRODUCTS</div>
              {recentProducts.map(p => (
                <div key={p.id} className="term-product-row">
                  <div className="term-product-image">IMAGE</div>
                  <div className="term-product-details">
                    <div className="term-product-name">{p.productName ?? 'Unknown'}</div>
                    <div className="term-product-sku">{p.sku ?? p.reference}</div>
                  </div>
                  <div className="term-product-stats">
                    <span className="term-muted">Exp: {p.expected}</span>
                    <span style={{color: 'var(--term-green)', fontWeight: 'bold'}}>Rec: {p.received}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'MANUAL_ENTRY' && (
        <div className="term-scanner-view">
          <div className="term-scanner-header">MANUAL PRODUCT ENTRY</div>
          <div className="term-manual-entry">
            <input 
              className="term-input" 
              placeholder="ENTER PRODUCT CODE" 
              value={manualCode}
              onChange={e => setManualCode(e.target.value)}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  processScan(manualCode, 'MANUAL');
                  setManualCode('');
                }
              }}
            />
            <button 
              className="term-btn-confirm" 
              onClick={() => {
                processScan(manualCode, 'MANUAL');
                setManualCode('');
              }}
              disabled={!manualCode.trim()}
            >SEARCH PRODUCT</button>
            <button className="term-btn-cancel" onClick={goHome}>CANCEL</button>
          </div>
        </div>
      )}

      {view === 'PRODUCT_RESULT' && (
        <div className="term-result-view">
          {flashMsg && <div className={`term-flash-msg ${flashMsg.kind}`}>{flashMsg.text}</div>}
          
          <div className={`term-result-header ${matchedProduct ? '' : 'error'}`}>
            {matchedProduct ? 'PRODUCT FOUND' : 'UNEXPECTED PRODUCT'}
          </div>

          <div className="term-result-card">
            <div className="term-product-image">IMAGE</div>
            <div className="term-result-info">
              <div className="term-product-name" style={{fontSize: '1.2rem'}}>{matchedProduct?.productName ?? 'Unknown Product'}</div>
              <div className="term-product-sku" style={{fontSize: '1rem'}}>SKU: {matchedProduct?.sku ?? scannedCode}</div>
              
              <div style={{marginTop: '16px', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--term-border)', paddingTop: '8px'}}>
                <div>
                  <div className="term-muted" style={{fontSize: '0.8rem'}}>EXPECTED</div>
                  <div style={{fontSize: '1.2rem', fontWeight: 'bold'}}>{matchedProduct?.expected ?? 0}</div>
                </div>
                <div>
                  <div className="term-muted" style={{fontSize: '0.8rem'}}>RECEIVED</div>
                  <div style={{fontSize: '1.2rem', fontWeight: 'bold'}}>{matchedProduct?.received ?? 0}</div>
                </div>
                <div>
                  <div className="term-muted" style={{fontSize: '0.8rem'}}>REMAINING</div>
                  <div style={{fontSize: '1.2rem', fontWeight: 'bold'}}>{matchedProduct?.remaining ?? 0}</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{borderTop: '1px solid var(--term-border)', paddingTop: '16px'}}>
            <div className="term-section-title" style={{padding: '0', textAlign: 'center'}}>QUANTITY</div>
            <div className="term-qty-control">
              <button className="term-qty-btn" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
              <div className="term-qty-value">{qty}</div>
              <button className="term-qty-btn" onClick={() => setQty(qty + 1)}>+</button>
            </div>
          </div>

          <button className="term-btn-confirm" onClick={confirmReceiving} disabled={busy}>
            CONFIRM RECEIVING
          </button>
          <button className="term-btn-cancel" onClick={goHome} disabled={busy}>
            CANCEL
          </button>
        </div>
      )}

      {view === 'SCANNER_CAMERA' && (
        <Suspense fallback={<div className="term-muted" style={{padding: '32px'}}>STARTING SCANNER...</div>}>
          <ReceivingScanner
            title="SCAN PRODUCT"
            enableOcr={ocrAllowed}
            mode="PRODUCT"
            corpus={corpus}
            scanContext={scanContext}
            onDetected={(val, src) => { setView('HOME'); processScan(val, src); }}
            onClose={goHome}
          />
        </Suspense>
      )}

      <div className="term-bottom-nav">
        <button className="term-nav-btn active">RCV HOME</button>
        <button className="term-nav-btn" onClick={async () => {
          if (confirm('Complete Receiving Session?')) {
            await api.complete(session.id);
            setSession(null);
            setView('ARRIVALS');
          }
        }}>COMPLETE</button>
        <button className="term-nav-btn" onClick={() => {
          setSession(null);
          setView('ARRIVALS');
        }}>EXIT</button>
      </div>

    </div>
  );
}
