import { useCallback, useEffect, useState } from 'react';
import client from '../../api/client';

/**
 * Traceability board (Admin Control Center).
 *
 * The non-negotiable chain, on one screen: search/scan any article code and
 * see CRM Card → Expected Arrival → Carton → Receiving Session → Container →
 * Storage Location → Customer Order → Bin → Outbound Shipment → Tracking →
 * SHIPPED. Below it: the live board of recent article units.
 */

interface ArticleRow {
  code: string;
  sku: string;
  productName: string | null;
  category: string | null;
  subcategory: string | null;
  status: string;
  updatedAt: string;
  container: { code: string; label: string | null } | null;
  currentLocation: { locationCode: string } | null;
  order: { externalOrderReference: string; externalCustomerReference: string } | null;
  outboundShipment: { code: string; status: string } | null;
}

interface Trace {
  article: {
    code: string; sku: string; productName: string | null;
    category: string | null; subcategory: string | null;
    categoryStatus: string; status: string;
  };
  trace: {
    crmCard: string | null;
    expectedArrival: string | null;
    inboundShipment: string | null;
    sourceCarton: string | null;
    receivingSession: string | null;
    container: { code: string; type: string; label: string | null } | null;
    storageLocation: { code: string; zone: string } | null;
    customerOrder: string | null;
    customer: string | null;
    outboundShipment: string | null;
    tracking: string | null;
    shippedAt: string | null;
  };
}

const STATUS_TAG: Record<string, string> = {
  SHIPPED: 'os-tag--ok',
  PACKED: 'os-tag--ok',
  IN_CUSTOMER_BIN: 'os-tag--ok',
  STORED: 'os-tag--muted',
  IN_CONTAINER: 'os-tag--warn',
  RECEIVED: 'os-tag--warn',
};

/** One hop of the chain; dim when the article has not reached it yet. */
function Hop({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={`tr-hop${value ? '' : ' is-empty'}`}>
      <div className="tr-hop-k">{label}</div>
      <div className="tr-hop-v mono">{value ?? '—'}</div>
    </div>
  );
}

export default function Traceability() {
  const [rows, setRows] = useState<ArticleRow[] | null>(null);
  const [status, setStatus] = useState<string>('ALL');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [traceBusy, setTraceBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (status !== 'ALL') params.status = status;
      if (query.trim()) params.q = query.trim();
      const r = await client.get<ArticleRow[]>('/v1/fulfillment/articles', { params });
      setRows(r.data);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Failed to load articles.');
    }
  }, [status, query]);

  useEffect(() => { void load(); }, [load]);

  async function openTrace(code: string) {
    setTraceBusy(true);
    try {
      const r = await client.get<Trace>(`/v1/fulfillment/articles/${encodeURIComponent(code)}/trace`);
      setTrace(r.data);
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Article not found.');
      setTrace(null);
    } finally {
      setTraceBusy(false);
    }
  }

  return (
    <>
      <style>{`
        .tr-chain { display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; }
        .tr-hop { min-width: 130px; flex: 1; background: var(--surface-2); border: 1px solid var(--border);
                  border-radius: var(--os-radius-sm); padding: 8px 10px; }
        .tr-hop.is-empty { opacity: 0.4; }
        .tr-hop-k { font-size: 0.6rem; letter-spacing: 0.14em; color: var(--muted); }
        .tr-hop-v { font-size: 0.82rem; font-weight: 700; word-break: break-all; margin-top: 2px; }
      `}</style>

      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title">Traceability</h1>
          <p className="ac-sub">Card → Carton → Receiving → Container → Location → Order → Bin → Shipment → SHIPPED.</p>
        </div>
        <div className="os-row">
          <input
            className="os-input"
            style={{ minWidth: 220 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const v = query.trim().toUpperCase();
                if (v.startsWith('ART-')) void openTrace(v);
                else void load();
              }
            }}
            placeholder="ART-… / SKU"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <button className="os-btn" onClick={() => void load()}>SEARCH</button>
        </div>
      </header>

      {error && <div className="ac-error">{error}</div>}

      {trace && (
        <section className="os-card" style={{ marginBottom: 14 }}>
          <div className="os-spread" style={{ marginBottom: 10 }}>
            <h2 className="os-card-title" style={{ margin: 0 }}>
              <span className="mono">{trace.article.code}</span> · {trace.article.sku}
              {trace.article.productName ? ` · ${trace.article.productName}` : ''}
            </h2>
            <div className="os-row">
              <span className={`os-tag ${STATUS_TAG[trace.article.status] ?? 'os-tag--muted'}`}>{trace.article.status}</span>
              <button className="os-btn" onClick={() => setTrace(null)}>CLOSE</button>
            </div>
          </div>
          <div className="tr-chain">
            <Hop label="CRM CARD" value={trace.trace.crmCard} />
            <Hop label="ARRIVAL" value={trace.trace.expectedArrival} />
            <Hop label="INBOUND SHIPMENT" value={trace.trace.inboundShipment} />
            <Hop label="SOURCE CARTON" value={trace.trace.sourceCarton} />
            <Hop label="RECEIVING SESSION" value={trace.trace.receivingSession} />
            <Hop
              label="CONTAINER"
              value={trace.trace.container ? `${trace.trace.container.code}${trace.trace.container.label ? ` (${trace.trace.container.label})` : ''}` : null}
            />
            <Hop
              label="STORAGE LOCATION"
              value={trace.trace.storageLocation ? `${trace.trace.storageLocation.code} · ${trace.trace.storageLocation.zone}` : null}
            />
            <Hop label="CUSTOMER ORDER" value={trace.trace.customerOrder} />
            <Hop label="CUSTOMER" value={trace.trace.customer} />
            <Hop label="OUTBOUND SHIPMENT" value={trace.trace.outboundShipment} />
            <Hop label="TRACKING" value={trace.trace.tracking} />
            <Hop
              label="SHIPPED AT"
              value={trace.trace.shippedAt ? new Date(trace.trace.shippedAt).toLocaleString() : null}
            />
          </div>
        </section>
      )}

      <section className="os-card">
        <div className="os-spread" style={{ marginBottom: 10 }}>
          <h2 className="os-card-title" style={{ margin: 0 }}>Recent articles</h2>
          <div className="os-row">
            {['ALL', 'IN_CONTAINER', 'STORED', 'IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'].map((s) => (
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
        </div>
        {!rows ? (
          <div className="os-empty">loading articles…</div>
        ) : rows.length === 0 ? (
          <div className="os-empty">No articles match.</div>
        ) : (
          <table className="os-table">
            <thead>
              <tr>
                <th>Article</th><th>SKU</th><th>Category</th><th>Status</th>
                <th>Container</th><th>Location</th><th>Order / Customer</th><th>Shipment</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td className="mono">{r.code}</td>
                  <td className="mono">{r.sku}</td>
                  <td>{r.category ?? '—'}{r.subcategory ? ` / ${r.subcategory}` : ''}</td>
                  <td><span className={`os-tag ${STATUS_TAG[r.status] ?? 'os-tag--muted'}`}>{r.status.replace(/_/g, ' ')}</span></td>
                  <td className="mono">{r.container ? `${r.container.code}${r.container.label ? ` (${r.container.label})` : ''}` : '—'}</td>
                  <td className="mono">{r.currentLocation?.locationCode ?? '—'}</td>
                  <td>{r.order ? `${r.order.externalOrderReference} · ${r.order.externalCustomerReference}` : '—'}</td>
                  <td className="mono">{r.outboundShipment?.code ?? '—'}</td>
                  <td>
                    <button className="os-btn" disabled={traceBusy} onClick={() => void openTrace(r.code)}>
                      TRACE
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
