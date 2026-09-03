import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import client from '../../api/client';
import { adminApi, type ContainerDetail as Detail } from '../api';

/**
 * CONTAINER DETAILS (COMMAND #1 FINAL §09) — Container → Contents, with full
 * provenance so the admin can jump Container → Article → Source Carton →
 * Receiving Session → Customer Order → Customer Bin → Shipment wherever a
 * real screen exists. Empty/unknown values render as —, never fabricated.
 */

interface Trace {
  article: { code: string; status: string };
  trace: {
    crmCard: string | null;
    expectedArrival: string | null;
    sourceCarton: string | null;
    receivingSession: string | null;
    container: { code: string; type: string } | null;
    storageLocation: { code: string } | null;
    customerOrder: string | null;
    customer: string | null;
    outboundShipment: string | null;
    tracking: string | null;
    shippedAt: string | null;
  };
}

function tag(status: string) {
  const map: Record<string, string> = {
    FULL: 'os-tag--err', ACTIVE: 'os-tag--ok', OPEN: 'os-tag--ok',
    READY_FOR_PACKING: 'os-tag--warn', PACKED: 'os-tag--ok', CLOSED: 'os-tag--muted',
    RECEIVED: 'os-tag--warn', IN_CONTAINER: 'os-tag--info', STORED: 'os-tag--muted',
    IN_CUSTOMER_BIN: 'os-tag--ok', SHIPPED: 'os-tag--ok',
  };
  return `os-tag ${map[status] ?? 'os-tag--muted'}`;
}

export default function ContainerDetail() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [traceCode, setTraceCode] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [traceErr, setTraceErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!code) return;
    setBusy(true);
    try {
      setData(await adminApi.container(code));
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Container not found.');
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [code]);

  useEffect(() => { void load(); }, [load]);

  async function openArticleTrace(articleCode: string) {
    if (traceCode === articleCode) { setTraceCode(null); setTrace(null); return; }
    setTraceCode(articleCode);
    setTrace(null);
    setTraceErr(null);
    try {
      const r = await client.get<Trace>(`/v1/fulfillment/articles/${encodeURIComponent(articleCode)}/trace`);
      setTrace(r.data);
    } catch (e: any) {
      setTraceErr(e?.response?.data?.message ?? 'Trace unavailable.');
    }
  }

  const c = data?.container;

  return (
    <>
      <header className="ac-head os-spread">
        <div>
          <h1 className="ac-title mono">Container {code ?? ''}</h1>
          <p className="ac-sub">
            Container → Article → Source Carton → Receiving Session → Customer Order → Bin → Shipment.
            Links open the deepest real screen available.
          </p>
        </div>
        <button type="button" className="os-btn" onClick={() => void load()} disabled={busy}>
          {busy ? '…' : 'Refresh'}
        </button>
      </header>

      {error && <div className="ac-error" style={{ marginBottom: 12 }}>{error}</div>}
      {!error && !data && <div className="os-empty">loading container…</div>}

      {c && (
        <>
          <section className="os-card">
            <h2 className="os-card-title">Container</h2>
            <div className="ac-kpis" style={{ marginTop: 8 }}>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono">{c.code}</div>
                <div className="ac-kpi-label">Container ID</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono">{c.type}</div>
                <div className="ac-kpi-label">Type</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono">{c.capacity}</div>
                <div className="ac-kpi-label">Capacity</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono">{c.count}</div>
                <div className="ac-kpi-label">Current count</div>
              </div>
              <div className="ac-kpi">
                <span className={`os-tag ${tag(c.status)}`}>{c.status}</span>
                <div className="ac-kpi-label">Status</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value">{c.worker?.name ?? '—'}</div>
                <div className="ac-kpi-label">Worker</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono">{c.station?.code ?? '—'}</div>
                <div className="ac-kpi-label">Station</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono" style={{ fontSize: 12 }}>{new Date(c.createdAt).toLocaleString()}</div>
                <div className="ac-kpi-label">Created at</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono" style={{ fontSize: 12 }}>
                  {c.closedAt ? new Date(c.closedAt).toLocaleString() : '—'}
                </div>
                <div className="ac-kpi-label">Closed at · {c.dbStatus === 'CLOSED' ? `status ${c.dbStatus} ` : 'not modelled yet '}· closed bins show CLOSED + updated</div>
              </div>
              <div className="ac-kpi">
                <div className="ac-kpi-value mono" style={{ fontSize: 12 }}>{new Date(c.lastActivity).toLocaleString()}</div>
                <div className="ac-kpi-label">Last activity</div>
              </div>
              {c.order && (
                <div className="ac-kpi">
                  <div className="ac-kpi-value mono" style={{ fontSize: 12 }}>
                    {c.order.reference} · {c.order.customer}
                  </div>
                  <div className="ac-kpi-label">Order · {c.order.status}</div>
                </div>
              )}
              {c.sortingWorker && (
                <div className="ac-kpi">
                  <div className="ac-kpi-value">{c.sortingWorker.name}</div>
                  <div className="ac-kpi-label">Sorting worker (ITEM_PICKED)</div>
                </div>
              )}
            </div>
          </section>

          <section className="os-card">
            <h2 className="os-card-title">Contents · {data.articles.length} article(s)</h2>
            {data.articles.length === 0 ? (
              <div className="os-empty">This container is empty.</div>
            ) : (
              <div className="ac-scroll">
                <table className="os-table">
                  <thead>
                    <tr>
                      <th>Article</th><th>SKU</th><th>Product</th><th>Source carton</th>
                      <th>Receiving session</th><th>Status</th><th>Order</th><th>Trace</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.articles.map((a) => (
                      <tr key={a.id}>
                        <td className="mono">{a.code}</td>
                        <td className="mono">{a.sku}</td>
                        <td>
                          {a.productName ?? '—'}
                          {a.category && <div className="os-muted" style={{ fontSize: 11 }}>{a.category}{a.categoryStatus ? ` · ${a.categoryStatus}` : ''}</div>}
                        </td>
                        <td className="mono">{a.sourceCarton?.code ?? '—'}</td>
                        <td className="mono">
                          {a.receivingSession ? (
                            <button
                              className="ac-linkbtn mono"
                              onClick={() => navigate(`/admin/sessions/${a.receivingSession!.id}`)}
                            >
                              {a.receivingSession.code}
                            </button>
                          ) : <span className="os-muted">—</span>}
                        </td>
                        <td><span className={tag(a.status)}>{a.status.replace(/_/g, ' ')}</span></td>
                        <td className="mono" style={{ fontSize: 11 }}>
                          {a.order ? `${a.order.reference} · ${a.order.customer}` : '—'}
                          {a.outboundShipment && <div>{a.outboundShipment.code} ({a.outboundShipment.status})</div>}
                          {a.currentLocation && <div>@{a.currentLocation.locationCode}</div>}
                        </td>
                        <td>
                          <button
                            className="ac-linkbtn mono"
                            onClick={() => { void openArticleTrace(a.code); }}
                          >
                            {traceCode === a.code ? 'hide' : 'trace'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {traceCode && (
              <div style={{ marginTop: 14 }}>
                <h3 className="os-card-title" style={{ fontSize: 13 }}>Trace · {traceCode}</h3>
                {traceErr && <div className="ac-error">{traceErr}</div>}
                {trace && (
                  <div className="tr-chain">
                    {[
                      ['CRM Card', trace.trace.crmCard],
                      ['Expected Arrival', trace.trace.expectedArrival],
                      ['Source Carton', trace.trace.sourceCarton],
                      ['Receiving Session', trace.trace.receivingSession],
                      ['Container', trace.trace.container?.code ?? null],
                      ['Location', trace.trace.storageLocation?.code ?? null],
                      ['Order', trace.trace.customerOrder],
                      ['Customer', trace.trace.customer],
                      ['Shipment', trace.trace.outboundShipment],
                      ['Shipped', trace.trace.shippedAt ? new Date(trace.trace.shippedAt).toLocaleString() : null],
                    ].map(([label, value]) => (
                      <div key={String(label)} className={`tr-hop${value ? '' : ' is-empty'}`}>
                        <div className="tr-hop-k">{label}</div>
                        <div className="tr-hop-v mono">{value ?? '—'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
