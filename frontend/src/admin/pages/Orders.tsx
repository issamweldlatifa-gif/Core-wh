import { useCallback, useEffect, useState } from 'react';
import client from '../../api/client';

/**
 * Orders board (Admin Control Center).
 *
 * Read-only surface over the order projection: orders arrive ONLY through
 * the service-authenticated integration endpoint (external system of
 * record), so there is deliberately no create/edit here. The board answers:
 * which orders are open, how far is fulfilment (articles vs requested),
 * which bin/shipment belongs to each order.
 */

interface OrderRow {
  id: string;
  externalOrderReference: string;
  externalCustomerReference: string;
  source: string;
  status: string;
  createdAt: string;
  _count: { items: number; containers: number; outboundShipments: number };
}

interface OrderDetail {
  externalOrderReference: string;
  externalCustomerReference: string;
  source: string;
  status: string;
  note: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    requestedQuantity: number;
    status: string;
    product: { externalProductCode: string; name: string; store: string };
  }>;
  containers: Array<{ code: string; type: string; status: string; label: string | null }>;
  outboundShipments: Array<{
    code: string; status: string; carrier: string | null;
    trackingNumber: string | null; shippedAt: string | null;
  }>;
  articleUnits: Array<{ code: string; sku: string; status: string }>;
}

const BIN_TAG: Record<string, string> = {
  READY_FOR_PACKING: 'os-tag--ok',
  PACKED: 'os-tag--ok',
  ACTIVE: 'os-tag--muted',
  CLOSED: 'os-tag--muted',
};

export default function Orders() {
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [status, setStatus] = useState<'ALL' | 'OPEN' | 'CANCELLED'>('OPEN');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (status !== 'ALL') params.status = status;
      if (query.trim()) params.q = query.trim();
      const r = await client.get<OrderRow[]>('/v1/orders', { params });
      setRows(r.data);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Failed to load orders.');
    }
  }, [status, query]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(reference: string) {
    try {
      const r = await client.get<OrderDetail>(`/v1/orders/${encodeURIComponent(reference)}`);
      setDetail(r.data);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Order not found.');
    }
  }

  /** Fulfilled units for one order line (assigned to bin, packed or shipped). */
  function fulfilled(d: OrderDetail, sku: string): number {
    return d.articleUnits.filter(
      (a) => a.sku === sku && ['IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'].includes(a.status),
    ).length;
  }

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Orders</h1>
          <p className="ac-sub">External order projection — intake happens only via the integration API.</p>
        </div>
        <div className="os-row">
          <input
            className="os-input"
            style={{ minWidth: 220 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void load(); } }}
            placeholder="ORDER REF / CUSTOMER"
            autoCapitalize="characters"
            spellCheck={false}
          />
          {(['OPEN', 'CANCELLED', 'ALL'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`os-btn${status === s ? ' os-btn--primary' : ''}`}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="ac-error">{error}</div>}

      {detail && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <div className="os-spread" style={{ marginBottom: 10 }}>
            <h2 className="os-card-title" style={{ margin: 0 }}>
              <span className="mono">{detail.externalOrderReference}</span>
              {' · '}{detail.externalCustomerReference}
            </h2>
            <div className="os-row">
              <span className={`os-tag ${detail.status === 'OPEN' ? 'os-tag--ok' : 'os-tag--muted'}`}>{detail.status}</span>
              <span className="os-tag os-tag--muted">{detail.source}</span>
              <button className="os-btn" onClick={() => setDetail(null)}>CLOSE</button>
            </div>
          </div>

          <table className="os-table" style={{ marginBottom: 12 }}>
            <thead>
              <tr><th>SKU</th><th>Product</th><th>Store</th><th>Fulfilled / Requested</th><th>Line status</th></tr>
            </thead>
            <tbody>
              {detail.items.map((it) => {
                const have = fulfilled(detail, it.product.externalProductCode);
                const done = have >= it.requestedQuantity;
                return (
                  <tr key={it.id}>
                    <td className="mono">{it.product.externalProductCode}</td>
                    <td>{it.product.name}</td>
                    <td>{it.product.store}</td>
                    <td>
                      <span className={`os-tag ${done ? 'os-tag--ok' : 'os-tag--warn'}`}>
                        {have}/{it.requestedQuantity}
                      </span>
                    </td>
                    <td><span className="os-tag os-tag--muted">{it.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="os-row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div>
              <div className="os-label">CUSTOMER BINS</div>
              {detail.containers.length === 0 ? (
                <div className="os-muted">none yet</div>
              ) : detail.containers.map((c) => (
                <div key={c.code} className="os-row" style={{ gap: 8, marginTop: 4 }}>
                  <span className="mono">{c.code}</span>
                  {c.label && <span>{c.label}</span>}
                  <span className={`os-tag ${BIN_TAG[c.status] ?? 'os-tag--muted'}`}>{c.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="os-label">OUTBOUND SHIPMENTS</div>
              {detail.outboundShipments.length === 0 ? (
                <div className="os-muted">none yet</div>
              ) : detail.outboundShipments.map((s) => (
                <div key={s.code} className="os-row" style={{ gap: 8, marginTop: 4 }}>
                  <span className="mono">{s.code}</span>
                  <span className={`os-tag ${s.status === 'SHIPPED' ? 'os-tag--ok' : 'os-tag--warn'}`}>{s.status.replace(/_/g, ' ')}</span>
                  <span className="os-muted">{s.carrier ?? 'INTERNAL'} · {s.trackingNumber ?? '—'}</span>
                  {s.shippedAt && <span className="os-muted">{new Date(s.shippedAt).toLocaleString()}</span>}
                </div>
              ))}
            </div>
            {detail.note && (
              <div>
                <div className="os-label">NOTE</div>
                <div className="os-muted">{detail.note}</div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="os-card">
        {!rows ? (
          <div className="os-empty">loading orders…</div>
        ) : rows.length === 0 ? (
          <div className="os-empty">No {status.toLowerCase()} orders.</div>
        ) : (
          <table className="os-table">
            <thead>
              <tr>
                <th>Order</th><th>Customer</th><th>Source</th><th>Status</th>
                <th>Lines</th><th>Bins</th><th>Shipments</th><th>Created</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.externalOrderReference}</td>
                  <td>{o.externalCustomerReference}</td>
                  <td><span className="os-tag os-tag--muted">{o.source}</span></td>
                  <td><span className={`os-tag ${o.status === 'OPEN' ? 'os-tag--ok' : 'os-tag--muted'}`}>{o.status}</span></td>
                  <td>{o._count.items}</td>
                  <td>{o._count.containers}</td>
                  <td>{o._count.outboundShipments}</td>
                  <td className="os-muted">{new Date(o.createdAt).toLocaleString()}</td>
                  <td>
                    <button className="os-btn" onClick={() => void openDetail(o.externalOrderReference)}>
                      OPEN
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
