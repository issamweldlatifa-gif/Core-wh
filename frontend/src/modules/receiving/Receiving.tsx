import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ReceivingArrival, type ReceivingSessionDetail } from './api';
import { useAuth } from '../../context/AuthContext';

/** Generate a short client operation id for network-retry idempotency. */
function opId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

export default function Receiving() {
  const { hasPermission } = useAuth();
  const canResolve = hasPermission('receiving.resolve_discrepancy');

  const [arrivals, setArrivals] = useState<ReceivingArrival[]>([]);
  const [session, setSession] = useState<ReceivingSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scanRef = useRef<HTMLInputElement>(null);
  const productRef = useRef<HTMLInputElement>(null);
  const productQtyRef = useRef<HTMLInputElement>(null);
  const [scanType, setScanType] = useState<'QR' | 'BARCODE' | 'MANUAL'>('QR');

  const loadArrivals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setArrivals(await api.arrivals());
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadArrivals();
  }, [loadArrivals]);

  // Keep focus on the scan field after every render while a session is open.
  useEffect(() => {
    if (session && session.status === 'RECEIVING') {
      const t = setTimeout(() => scanRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [session]);

  const apply = (next: ReceivingSessionDetail) => {
    setSession(next);
    // Refresh the arrival picker (statuses change as we receive).
    api.arrivals().then(setArrivals).catch(() => {});
  };

  const guard = async (fn: () => Promise<ReceivingSessionDetail>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      apply(await fn());
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  async function start(a: ReceivingArrival) {
    await guard(async () => {
      // Resume existing session if one is active.
      const active = await api.active(a.code);
      return active ?? (await api.start(a.code));
    });
  }

  async function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = scanRef.current?.value.trim();
    if (!code || !session) return;
    if (scanRef.current) scanRef.current.value = '';
    await guard(() => api.scanCarton(session.id, code, scanType, opId()));
  }

  async function confirmCarton(cartonCode: string) {
    if (!session) return;
    await guard(() => api.receiveCarton(session.id, cartonCode, opId()));
  }

  async function onProductSubmit(e: React.FormEvent) {
    e.preventDefault();
    const sku = productRef.current?.value.trim();
    const qty = Math.max(1, parseInt(productQtyRef.current?.value || '1', 10) || 1);
    if (!sku || !session) return;
    if (productRef.current) productRef.current.value = '';
    if (productQtyRef.current) productQtyRef.current.value = '1';
    await guard(async () => {
      const r = await api.receiveProduct(session.id, sku, qty);
      productRef.current?.focus();
      return r;
    });
  }

  const flash = session?.flash;
  const t = session?.tally;
  const finished = session && (session.status === 'COMPLETED' || session.status === 'COMPLETED_WITH_DISCREPANCY');

  return (
    <>
      <h1 className="page-title">Receiving Terminal</h1>
      <p className="page-sub">
        Carton-first receiving against Expected Arrivals. Scan a carton QR/barcode — expected data is
        never modified; every physical action is recorded.
      </p>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}

      {!session && (
        <div className="card">
          {loading ? (
            <p className="empty">Loading…</p>
          ) : arrivals.length === 0 ? (
            <p className="empty">No arrivals awaiting receiving.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Warehouse ID</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Carrier</th>
                  <th>Tracking</th>
                  <th>Cartons</th>
                  <th>Units</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {arrivals.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.code}</strong></td>
                    <td>{a.customerName}</td>
                    <td><span className={`tag ${a.status === 'EXPECTED' ? 'yellow' : 'accent'}`}>{a.status}</span></td>
                    <td>{a.carrier ?? '—'}</td>
                    <td>{a.tracking ?? '—'}</td>
                    <td>{a.cartons}</td>
                    <td>{a.units}</td>
                    <td>
                      <button className="btn-primary" disabled={busy} onClick={() => start(a)}>
                        {a.status === 'EXPECTED' ? 'Start receiving' : 'Resume'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {session && (
        <div className="receiving-grid">
          {/* LEFT: scan + identification */}
          <div className="receiving-main">
            <div className="card">
              <div className="rcv-head">
                <div>
                  <div className="rcv-code">{session.code}</div>
                  <div className="rcv-arrival">
                    {session.arrival.code} · {session.arrival.customerName}
                  </div>
                </div>
                <span className={`tag ${STATUS_TAG[session.status] ?? 'gray'}`}>{session.status}</span>
              </div>

              {!finished && (
                <form onSubmit={onScanSubmit} className="scan-box">
                  <div className="scan-row">
                    <select
                      value={scanType}
                      onChange={(e) => setScanType(e.target.value as any)}
                      className="scan-type"
                      disabled={busy || session.status !== 'RECEIVING'}
                    >
                      <option value="QR">QR</option>
                      <option value="BARCODE">Barcode</option>
                      <option value="MANUAL">Manual</option>
                    </select>
                    <input
                      ref={scanRef}
                      className="scan-input"
                      placeholder="Scan carton label (CTN-…) or press Enter"
                      autoFocus
                      disabled={busy || session.status !== 'RECEIVING'}
                    />
                    <button type="submit" className="btn-primary" disabled={busy || session.status !== 'RECEIVING'}>
                      Identify
                    </button>
                  </div>
                </form>
              )}

              {/* Identification flash */}
              {flash && (flash.kind === 'CARTON_IDENTIFIED' || flash.kind === 'WRONG_SHIPMENT' || flash.kind === 'UNKNOWN_CARTON' || flash.kind === 'DUPLICATE_CARTON') && (
                <div className={`identify ${
                  flash.kind === 'CARTON_IDENTIFIED' ? 'identify-ok'
                  : flash.kind === 'DUPLICATE_CARTON' ? 'identify-warn'
                  : 'identify-bad'
                }`}>
                  {flash.kind === 'CARTON_IDENTIFIED' && (
                    <>
                      <div className="identify-title">✓ Carton identified — confirm receipt</div>
                      <div className="identify-grid">
                        <div><span>Carton</span><strong>{flash.carton?.externalCartonId}</strong></div>
                        <div><span>Box</span><strong>{flash.carton?.cartonNumber} / {flash.carton?.totalCartons}</strong></div>
                        <div><span>Shipment</span><strong>{flash.carton?.shipment?.code}</strong></div>
                        <div><span>External</span><strong>{flash.carton?.shipment?.externalShipmentId}</strong></div>
                        <div><span>Arrival</span><strong>{session.arrival.code}</strong></div>
                        <div><span>Customer</span><strong>{session.arrival.customerName}</strong></div>
                      </div>
                      <button
                        className="btn-primary big"
                        disabled={busy || session.status !== 'RECEIVING'}
                        onClick={() => confirmCarton(flash.carton?.externalCartonId ?? flash.carton?.id)}
                      >
                        ✓ CONFIRM CARTON RECEIVED
                      </button>
                    </>
                  )}
                  {flash.kind === 'DUPLICATE_CARTON' && (
                    <div className="identify-title">⟳ Already received — {flash.carton} (not counted again)</div>
                  )}
                  {flash.kind === 'WRONG_SHIPMENT' && (
                    <div className="identify-title">
                      ✗ Carton belongs to a different shipment ({flash.carton}). Discrepancy recorded — do NOT receive.
                    </div>
                  )}
                  {flash.kind === 'UNKNOWN_CARTON' && (
                    <div className="identify-title">
                      ? Unknown carton {flash.code} — not part of any expected shipment. Flagged for review.
                    </div>
                  )}
                </div>
              )}

              {/* Product scan */}
              {!finished && (
                <form onSubmit={onProductSubmit} className="scan-box product-box">
                  <div className="scan-row">
                    <input ref={productRef} className="scan-input" placeholder="Scan / enter product SKU" disabled={busy || session.status !== 'RECEIVING'} />
                    <input ref={productQtyRef} className="scan-qty" type="number" min={1} defaultValue={1} disabled={busy || session.status !== 'RECEIVING'} />
                    <button type="submit" className="btn-secondary" disabled={busy || session.status !== 'RECEIVING'}>
                      Add units
                    </button>
                  </div>
                  {flash?.kind === 'PRODUCT_MATCH' && (
                    <div className="flash-ok">✓ {flash.sku}: {flash.received}/{flash.expected} received</div>
                  )}
                  {flash?.kind === 'UNEXPECTED_PRODUCT' && (
                    <div className="flash-bad">? Unexpected product {flash.sku} — discrepancy recorded.</div>
                  )}
                </form>
              )}

              {/* Action bar */}
              {!finished && (
                <div className="action-bar">
                  {session.status === 'RECEIVING' ? (
                    <button className="btn-secondary" disabled={busy} onClick={() => guard(() => api.pause(session.id))}>Pause</button>
                  ) : (
                    <button className="btn-secondary" disabled={busy} onClick={() => guard(() => api.resume(session.id))}>Resume</button>
                  )}
                  <button
                    className="btn-primary"
                    disabled={busy}
                    onClick={() => guard(() => api.complete(session.id))}
                  >
                    Complete &amp; reconcile
                  </button>
                  <button className="btn-link" onClick={() => setSession(null)}>Switch arrival</button>
                </div>
              )}
              {finished && (
                <div className="action-bar">
                  <button className="btn-secondary" onClick={() => { setSession(null); loadArrivals(); }}>
                    Back to arrivals
                  </button>
                </div>
              )}
            </div>

            {/* Discrepancies */}
            {session.discrepancies.length > 0 && (
              <div className="card">
                <h3 className="drawer-section">Discrepancies ({session.discrepancies.filter((d) => d.status === 'OPEN').length} open)</h3>
                <table>
                  <thead>
                    <tr><th>Type</th><th>Ref</th><th>Exp</th><th>Recv</th><th>Note</th><th>Status</th>{canResolve && <th></th>}</tr>
                  </thead>
                  <tbody>
                    {session.discrepancies.map((d) => (
                      <tr key={d.id}>
                        <td><span className="tag red">{d.type.replace(/_/g, ' ')}</span></td>
                        <td>{d.cartonCode ?? d.sku ?? '—'}</td>
                        <td>{d.expectedQty ?? '—'}</td>
                        <td>{d.receivedQty ?? '—'}</td>
                        <td>{d.description ?? '—'}</td>
                        <td>
                          <span className={`tag ${d.status === 'OPEN' ? 'red' : 'green'}`}>{d.status}</span>
                          {d.resolvedByName && <div className="muted">by {d.resolvedByName}</div>}
                        </td>
                        {canResolve && (
                          <td>
                            {d.status === 'OPEN' && (
                              <button className="btn-secondary" disabled={busy} onClick={() => guard(() => api.resolve(d.id, 'Resolved by supervisor'))}>
                                Resolve
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* RIGHT: tally + products + cartons */}
          <div className="receiving-side">
            <div className="card tally-card">
              <div className="tally-grid">
                <div><strong>{t?.receivedCartons ?? 0}</strong><span>/{t?.expectedCartons ?? 0} cartons</span></div>
                <div><strong>{t?.receivedUnits ?? 0}</strong><span>/{t?.expectedUnits ?? 0} units</span></div>
                <div><strong>{t?.receivedProducts ?? 0}</strong><span>/{t?.expectedProducts ?? 0} products</span></div>
                <div className={t?.missingCartons ? 'tally-bad' : ''}><strong>{t?.missingCartons ?? 0}</strong><span>missing cartons</span></div>
                <div className={t?.shortUnits ? 'tally-bad' : ''}><strong>{t?.shortUnits ?? 0}</strong><span>short units</span></div>
                <div className={t?.openDiscrepancies ? 'tally-bad' : ''}><strong>{t?.openDiscrepancies ?? 0}</strong><span>open issues</span></div>
              </div>
            </div>

            <div className="card">
              <h3 className="drawer-section">Products</h3>
              <table className="tight">
                <thead><tr><th>SKU</th><th>Product</th><th>Exp</th><th>Recv</th><th>Left</th><th>Status</th></tr></thead>
                <tbody>
                  {session.products.map((p) => (
                    <tr key={p.id} className={p.status === 'RECEIVED' ? 'row-done' : ''}>
                      <td>{p.sku ?? p.reference ?? <em className="muted">no sku</em>}</td>
                      <td>{p.productName ?? '—'}</td>
                      <td>{p.expected}</td>
                      <td><strong>{p.received}</strong></td>
                      <td>{p.remaining}</td>
                      <td><span className={`tag ${PRODUCT_STATUS_TAG[p.status] ?? 'gray'}`}>{p.status.replace(/_/g, ' ')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3 className="drawer-section">Cartons received ({session.receivedCartonEvents.length})</h3>
              <table className="tight">
                <thead><tr><th>Code</th><th>Scan</th><th>When</th></tr></thead>
                <tbody>
                  {session.receivedCartonEvents.length === 0 && <tr><td colSpan={3} className="muted">None yet.</td></tr>}
                  {session.receivedCartonEvents.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.code}</strong></td>
                      <td>{c.scanType}</td>
                      <td className="muted">{c.receivedAt ? new Date(c.receivedAt).toLocaleTimeString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
