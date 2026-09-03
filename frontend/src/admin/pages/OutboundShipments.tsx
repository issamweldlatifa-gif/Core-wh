import { useCallback, useEffect, useState } from 'react';
import client from '../../api/client';

/**
 * Outbound Shipments board (Admin Control Center).
 *
 * Read-only surface over OutboundShipment: which parcels are packed and
 * waiting at the shipping area (READY_TO_SHIP) and which have left the
 * building (SHIPPED), with carrier/tracking when a real carrier adapter
 * fills them. Dispatch itself happens ONLY on the worker shipping terminal.
 */

interface ShipmentRow {
  code: string;
  status: 'READY_TO_SHIP' | 'SHIPPED';
  carrier: string | null;
  trackingNumber: string | null;
  packedAt: string;
  shippedAt: string | null;
  order: { externalOrderReference: string; externalCustomerReference: string };
  container: { code: string } | null;
  _count: { articles: number };
}

const FILTERS = ['READY_TO_SHIP', 'SHIPPED', 'ALL'] as const;
type Filter = (typeof FILTERS)[number];

export default function OutboundShipments() {
  const [rows, setRows] = useState<ShipmentRow[] | null>(null);
  const [status, setStatus] = useState<Filter>('READY_TO_SHIP');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (status !== 'ALL') params.status = status;
      if (query.trim()) params.q = query.trim();
      const r = await client.get<ShipmentRow[]>('/v1/fulfillment/outbound-shipments', { params });
      setRows(r.data);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Failed to load shipments.');
    }
  }, [status, query]);

  useEffect(() => { void load(); }, [load]);

  const waiting = rows?.filter((r) => r.status === 'READY_TO_SHIP').length ?? 0;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Outbound Shipments</h1>
          <p className="ac-sub">
            Packed parcels and dispatches — dispatch happens on the worker shipping terminal.
            {rows && status !== 'SHIPPED' && waiting > 0 && (
              <> Currently <strong>{waiting}</strong> waiting at the shipping area.</>
            )}
          </p>
        </div>
        <div className="os-row">
          <input
            className="os-input"
            style={{ minWidth: 240 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void load(); } }}
            placeholder="OUT- / ORDER / CUSTOMER / TRACKING"
            autoCapitalize="characters"
            spellCheck={false}
          />
          {FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className={`os-btn${status === s ? ' os-btn--primary' : ''}`}
              onClick={() => setStatus(s)}
            >
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="ac-error">{error}</div>}

      <section className="os-card">
        {!rows ? (
          <div className="os-empty">loading shipments…</div>
        ) : rows.length === 0 ? (
          <div className="os-empty">No {status === 'ALL' ? '' : status.replace(/_/g, ' ').toLowerCase() + ' '}shipments.</div>
        ) : (
          <table className="os-table">
            <thead>
              <tr>
                <th>Shipment</th><th>Order</th><th>Customer</th><th>Bin</th><th>Pieces</th>
                <th>Status</th><th>Carrier</th><th>Tracking</th><th>Packed</th><th>Shipped</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.code}>
                  <td className="mono">{s.code}</td>
                  <td className="mono">{s.order.externalOrderReference}</td>
                  <td>{s.order.externalCustomerReference}</td>
                  <td className="mono">{s.container?.code ?? '—'}</td>
                  <td>{s._count.articles}</td>
                  <td>
                    <span className={`os-tag ${s.status === 'SHIPPED' ? 'os-tag--ok' : 'os-tag--warn'}`}>
                      {s.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>{s.carrier ?? <span className="os-muted">INTERNAL</span>}</td>
                  <td className="mono">{s.trackingNumber ?? '—'}</td>
                  <td className="os-muted">{new Date(s.packedAt).toLocaleString()}</td>
                  <td className="os-muted">{s.shippedAt ? new Date(s.shippedAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
