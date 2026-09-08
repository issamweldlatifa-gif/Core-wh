import { useEffect, useState } from 'react';
import { api, type ExpectedArrival, type ExpectedArrivalDetail } from './api';
import { categoriesApi, type Category } from '../categories/api';
import { useAuth } from '../../context/AuthContext';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{value ?? '—'}</div>
    </div>
  );
}

export default function ExpectedArrivals() {
  const { hasPermission } = useAuth();
  const canResolve = hasPermission('inventory.manage');
  const [rows, setRows] = useState<ExpectedArrival[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExpectedArrivalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [master, setMaster] = useState<Category[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveCat, setResolveCat] = useState('');
  const [resolveSub, setResolveSub] = useState('');
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);

  useEffect(() => {
    if (!canResolve) return;
    categoriesApi.list().then((c) => setMaster(c.filter((x) => x.status === 'ACTIVE'))).catch(() => {});
  }, [canResolve]);

  async function resolveItem(itemId: string) {
    if (!resolveCat || !selected) return;
    setResolveBusy(true); setResolveErr(null);
    try {
      await api.changeCategory(itemId, { category: resolveCat, subcategory: resolveSub || null });
      const detail = await api.detail(selected.id);
      setSelected(detail);
      setResolving(null); setResolveCat(''); setResolveSub('');
    } catch (e: any) {
      setResolveErr(e?.response?.data?.message ?? e?.message ?? 'Failed to change category.');
    } finally {
      setResolveBusy(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.list();
      setRows(resp.data);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to load expected arrivals.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function open(row: ExpectedArrival) {
    setDetailError(null);
    setSelected(null);
    setDetailLoading(true);
    try {
      const detail = await api.detail(row.id);
      setSelected(detail);
    } catch (e: any) {
      setDetailError(e?.response?.data?.message ?? e?.message ?? 'Failed to load details.');
    } finally {
      setDetailLoading(false);
    }
  }

  const totalUnits = rows.reduce((s, r) => s + (r.units || 0), 0);

  return (
    <>
      <h1 className="page-title">Expected Arrivals</h1>
      <p className="page-sub">
        Customer Arrival Cards received from Arrival CRM via the integration API. Goods are{' '}
        <strong>expected to arrive</strong> — this is not physical receiving.
        <br />
        <strong style={{ color: '#0ea5e9' }}>CARTON FIX:</strong> Carton cards are now preserved as 📦 CARTON with suivi/QR/barcode, not as PRODUCT.
      </p>

      <div className="stats-row">
        <div className="stat">
          <div className="stat-num">{rows.length}</div>
          <div className="stat-label">Expected arrivals</div>
        </div>
        <div className="stat">
          <div className="stat-num">{totalUnits}</div>
          <div className="stat-label">Expected units</div>
        </div>
        <div className="stat">
          <div className="stat-num">{new Set(rows.map((r) => r.customerName)).size}</div>
          <div className="stat-label">Customers</div>
        </div>
      </div>

      <div className="card">
        {loading && <p className="empty">Loading…</p>}
        {error && <div className="error-box">{error}</div>}
        {!loading && !error && rows.length === 0 && (
          <p className="empty">
            No expected arrivals yet. Send a Customer Arrival Card from Arrival CRM → “Send to
            Warehouse”.
          </p>
        )}
        {!loading && !error && rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Warehouse ID</th>
                <th>Customer</th>
                <th>Store</th>
                <th>Products</th>
                <th>Units</th>
                <th>Source</th>
                <th>Status</th>
                <th>Received via API</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.code}</strong></td>
                  <td>{r.customerName}</td>
                  <td>{r.storeName ?? '—'}</td>
                  <td>{r.products}</td>
                  <td>{r.units}</td>
                  <td><span className="tag accent">ARRIVAL_CRM</span></td>
                  <td><span className="tag yellow">EXPECTED</span></td>
                  <td>{fmtDate(r.receivedViaApiAt)}</td>
                  <td>
                    <button className="btn-secondary" onClick={() => open(r)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detailLoading && (
        <div className="drawer-backdrop">
          <div className="drawer">
            <p className="empty">Loading details…</p>
          </div>
        </div>
      )}

      {!detailLoading && selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1100, width: '95%' }}>
            <div className="drawer-head">
              <h2>Expected Arrival · {selected.code}</h2>
              <button className="btn-secondary" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>

            <div className="tag-row">
              <span className="tag yellow">{selected.status}</span>
              <span className="tag accent">Source: {selected.source}</span>
            </div>

            <div className="field-grid">
              <Field label="Warehouse ID" value={<strong>{selected.code}</strong>} />
              <Field label="External Card" value={selected.customerArrivalCardId} />
              <Field label="Arrival" value={selected.arrivalId ?? (selected as any).arrivalReference ?? '—'} />
              <Field label="Customer" value={selected.customerName} />
              <Field label="Customer ID" value={selected.customerId} />
              <Field label="Store" value={selected.storeName ?? '—'} />
              <Field label="Status" value={selected.status} />
              <Field label="Source" value="Arrival CRM" />
              <Field label="Received via API" value={selected.receivedViaApi ? 'Yes' : 'No'} />
              <Field label="API Received At" value={fmtDate(selected.receivedViaApiAt)} />
              <Field label="Products" value={selected.products} />
              <Field label="Units" value={selected.units} />
            </div>

            {/* CARTON FIX */}
            {selected.shipments && selected.shipments.length > 0 && (
              <>
                <h3 className="drawer-section">📦 CARTON Cards ({selected.shipments.reduce((n, s) => n + s.cartons.length, 0)}) — CARTON FIX</h3>
                <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                  Each carton is displayed as <strong>CARTON</strong> with its own identity, suivi/tracking, QR/barcode, products count. Not as PRODUCT.
                </p>
                {selected.shipments.map((shipment) => (
                  <div key={shipment.id} style={{ marginBottom: 16, border: '1px solid #e0e0e0', borderRadius: 8, padding: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>
                      Shipment: {shipment.code} — Tracking: {shipment.trackingNumber ?? '—'} — Suivi: {shipment.suiviCode ?? '—'} — Carrier: {shipment.carrierName ?? '—'}
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>Carton ID</th>
                          <th>Suivi Code</th>
                          <th>Tracking</th>
                          <th>QR / Barcode</th>
                          <th>Products Count</th>
                          <th>Source</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shipment.cartons.map((ct) => (
                          <tr key={ct.id} style={{ background: ct.entityType === 'CARTON' ? '#f0f9ff' : undefined }}>
                            <td><span className="tag accent" style={{ background: '#0ea5e9', color: 'white' }}>📦 {ct.entityType || 'CARTON'}</span></td>
                            <td><strong>{ct.externalCartonId}</strong>{ct.reference ? <><br/><small>{ct.reference}</small></> : null}</td>
                            <td><code>{ct.suiviCode ?? '—'}</code></td>
                            <td><code>{ct.trackingCode ?? ct.suiviCode ?? '—'}</code></td>
                            <td>
                              QR: <code>{ct.qrCodeValue ?? '—'}</code><br/>
                              BC: <code>{ct.barcodeValue ?? '—'}</code>
                            </td>
                            <td><strong>{ct.productCount ?? 0}</strong></td>
                            <td>{ct.sourceProject ?? '—'}</td>
                            <td><span className="tag yellow">{ct.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </>
            )}

            <h3 className="drawer-section">Products ({selected.items.length}) — {selected.items.filter((i: any) => i.cartonId).length > 0 ? 'Some linked to CARTON' : 'Standalone PRODUCT cards'}</h3>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
              Products inside cartons are shown with CARTON link, but parent remains CARTON. PRODUCT cards remain functional.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>SKU</th>
                  <th>Reference</th>
                  <th>Product</th>
                  <th>Variant</th>
                  <th>Carton Link</th>
                  <th>Category</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {selected.items.map((it: any) => (
                  <tr key={it.id} style={{ background: it.cartonId ? '#f0fdf4' : undefined }}>
                    <td>{it.cartonId ? <span className="tag" style={{ background: '#10b981', color: 'white' }}>📦 Inside CARTON</span> : <span className="tag">🏷 PRODUCT</span>}</td>
                    <td>{it.sku ?? '—'}</td>
                    <td>{it.reference ?? '—'}</td>
                    <td>{it.productName ?? '—'}</td>
                    <td>{it.variant ?? '—'}</td>
                    <td>{it.cartonId ? <code>{it.cartonId.slice(0,8)}...</code> : '—'}</td>
                    <td>
                      {it.categoryStatus === 'CONFIRMED' && it.category
                        ? <span className="tag green">{it.category}{it.subcategory ? ` / ${it.subcategory}` : ''}{it.classificationSource ? ` · ${it.classificationSource}` : ''}</span>
                        : (
                          <>
                            <span className="tag yellow">{it.category ? `${it.category} · NEEDS REVIEW` : 'NEEDS REVIEW'}</span>
                            {canResolve && resolving !== it.id && (
                              <button
                                className="btn"
                                type="button"
                                style={{ marginLeft: 8 }}
                                onClick={() => { setResolving(it.id); setResolveCat(''); setResolveSub(''); setResolveErr(null); }}
                              >Resolve</button>
                            )}
                            {canResolve && resolving === it.id && (
                              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 8, flexWrap: 'wrap' }}>
                                <select value={resolveCat} onChange={(e) => { setResolveCat(e.target.value); setResolveSub(''); }}>
                                  <option value="">category…</option>
                                  {master.map((m) => <option key={m.id} value={m.code}>{m.code}</option>)}
                                </select>
                                {(master.find((m) => m.code === resolveCat)?.subcategories?.length ?? 0) > 0 && (
                                  <select value={resolveSub} onChange={(e) => setResolveSub(e.target.value)}>
                                    <option value="">subcategory…</option>
                                    {master.find((m) => m.code === resolveCat)!.subcategories.map((s) => (
                                      <option key={s} value={s}>{s}</option>
                                    ))}
                                  </select>
                                )}
                                <button className="btn" type="button" disabled={resolveBusy || !resolveCat} onClick={() => void resolveItem(it.id)}>Save</button>
                                <button className="btn" type="button" disabled={resolveBusy} onClick={() => setResolving(null)}>Cancel</button>
                                {resolveErr && <span className="tag yellow">{resolveErr}</span>}
                              </span>
                            )}
                          </>
                        )}
                    </td>
                    <td><strong>{it.quantity}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!detailLoading && detailError && (
        <div className="drawer-backdrop" onClick={() => setDetailError(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="error-box">{detailError}</div>
          </div>
        </div>
      )}
    </>
  );
}
