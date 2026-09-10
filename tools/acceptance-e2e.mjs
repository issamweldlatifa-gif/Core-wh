/* AYROVI acceptance E2E (local): Carton Flow vs Product Flow separation.
 * Runs against http://127.0.0.1:3000 (dev DB). No fake data — everything is
 * pushed through the REAL integration + receiving APIs. */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000/api/v1';
const API_KEY = process.env.INT_KEY ?? 'int_key_acceptance_123';
const UNIQ = Date.now().toString(36).toUpperCase();
const ARRIVAL = `ARR-ACC-${UNIQ}`;
const SHIPMENT = `SHP-ACC-${UNIQ}`;
const C1 = `CTN-ACC-${UNIQ}-1`;
const C2 = `CTN-ACC-${UNIQ}-2`;
const SKU1 = `SKU-ACC-${UNIQ}-1`;
const SKU2 = `SKU-ACC-${UNIQ}-2`;

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
}
async function call(method, path, { token, key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['x-api-key'] = key;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
const ok = (r) => r.status >= 200 && r.status < 300;

console.log(`=== SCENARIO: arrival ${ARRIVAL} ===\n`);

// 0. health
const h = await call('GET', '/system/health');
check('health endpoint (no-server regression)', ok(h), `status=${h.status}`);

// 1. Admin login (ADMIN_WEB)
const adminLogin = await call('POST', '/auth/login', {
  body: { identifier: 'ADMIN001', secret: 'AdminPass!2026', app: 'ADMIN_WEB' },
});
check('admin login', ok(adminLogin), `status=${adminLogin.status} ${JSON.stringify(adminLogin.json).slice(0,200)}`);
const adminToken = adminLogin.json?.accessToken;

// 2. CRM arrival card push (real inbound contract)
const card = {
  event: 'customer_arrival_card.created',
  arrival: { id: ARRIVAL, reference: ARRIVAL },
  customer_arrival_card: {
    id: ARRIVAL,
    customer: { id: 'CUS-ACC-TEST', name: 'Acceptance Customer' },
    store: { id: 'STORE-ACC', name: 'Store ACC' },
    products: [
      { sku: SKU1, product_id: 'PRD-ACC-1001', product_name: 'Product One ACC', quantity: 10, category: 'CLOTHING', subcategory: 'SHIRTS', classification_source: 'MANUAL' },
      { sku: SKU2, product_id: 'PRD-ACC-1002', product_name: 'Product Two ACC', quantity: 5, category: 'SHOES', subcategory: 'SNEAKERS', classification_source: 'MANUAL' },
    ],
  },
};
const pushArr = await call('POST', '/integrations/arrivals/customer-cards', { key: API_KEY, body: card });
check('CRM arrival card accepted', ok(pushArr), `status=${pushArr.status} ${JSON.stringify(pushArr.json).slice(0, 300)}`);
const arrivalId = pushArr.json?.warehouse_arrival_id ?? ARRIVAL;

// 3. CRM shipment card (2 cartons)
const shipment = {
  event: 'shipment.created',
  arrival: { id: arrivalId, reference: ARRIVAL },
  shipment: {
    id: SHIPMENT, reference: SHIPMENT,
    source: { type: 'MANUAL', reference: 'manual-acc' },
    carrier: { id: 'DHL-ACC', name: 'DHL ACC', code: 'DHL' },
    tracking: { tracking_number: `TRK-SHP-${UNIQ}`, status: 'IN_TRANSIT' },
    sender: { name: 'Sender ACC', country: 'CN', city: 'Yiwu' },
    destination: { country: 'TN', city: 'Tunis', code: 'AYROVI-WH-TN' },
    summary: { total_cartons: 2, total_products: 2, total_units: 15 },
    suivi_code: `SHP-SUI-${UNIQ}`,
    cartons: [
      { id: C1, carton_number: 1, total_cartons: 2, entity_type: 'CARTON', suivi_code: `SUI-ACC-${UNIQ}-1`, qr_code_value: `QR-${UNIQ}-1`, source_project: 'CRM-ACC',
        products: [{ sku: SKU1, product_name: 'Product One ACC', quantity: 6 }] },
      { id: C2, carton_number: 2, total_cartons: 2, entity_type: 'CARTON', suivi_code: `SUI-ACC-${UNIQ}-2`, qr_code_value: `QR-${UNIQ}-2`, source_project: 'CRM-ACC',
        products: [{ sku: SKU1, quantity: 4 }, { sku: SKU2, quantity: 5 }] },
    ],
  },
};
const pushShp = await call('POST', '/integrations/arrivals/shipments', { key: API_KEY, body: shipment });
check('CRM shipment card accepted', ok(pushShp), `status=${pushShp.status} ${JSON.stringify(pushShp.json).slice(0, 300)}`);

// 4. Worker login (WORKER_NATIVE)
const wl = await call('POST', '/auth/login', {
  body: { identifier: 'WORKER001', secret: 'WorkerPass!2026', app: 'WORKER_NATIVE' },
});
check('worker login', ok(wl), `status=${wl.status} ${JSON.stringify(wl.json).slice(0,200)}`);
const workerToken = wl.json?.accessToken;

const home0 = await call('GET', '/receiving/home', { token: workerToken });
const productCardVisible = JSON.stringify(home0.json).includes(SKU1);
check('worker home feed shows product card', ok(home0) && productCardVisible, `status=${home0.status} contains=${productCardVisible}`);

// 5. CARTON lane — scan CARTON 1 (verification + auto-approve)
const scanCarton1 = await call('POST', '/receiving/home/carton', {
  token: workerToken,
  body: { identifier: C1, identifierType: 'CARTON_REF', operationId: `op-c1-${UNIQ}`, source: 'CAMERA' },
});
check('carton1 scan CONFIRMED', ok(scanCarton1) && scanCarton1.json?.ok === true, `status=${scanCarton1.status} ${JSON.stringify(scanCarton1.json).slice(0,300)}`);

// 6. PRODUCT lane — scan both products fully
const p1 = await call('POST', '/receiving/home/product', {
  token: workerToken,
  body: { identifier: SKU1, quantity: 10, operationId: `op-p1-${UNIQ}`, source: 'CAMERA' },
});
check('product1 full scan verified', ok(p1) && p1.json?.ok === true, `status=${p1.status} ${JSON.stringify(p1.json).slice(0,300)}`);
const p2 = await call('POST', '/receiving/home/product', {
  token: workerToken,
  body: { identifier: SKU2, quantity: 5, operationId: `op-p2-${UNIQ}`, source: 'CAMERA' },
});
check('product2 full scan verified', ok(p2) && p2.json?.ok === true, `status=${p2.status} ${JSON.stringify(p2.json).slice(0,300)}`);

// 7. The reportable session is the one the scans created (captured from the
// carton scan — the same auto-resolve the worker app uses).
const sessionId = scanCarton1.json?.sessionId ?? p1.json?.sessionId;
check('session auto-created + captured from scan response', !!sessionId, `sessionId=${sessionId}`);

// 8. OPEN THE REPORT (this is the screen that used to hang)
const reportBefore = await call('GET', `/receiving/sessions/${sessionId}/report`, { token: workerToken });
const rb = reportBefore.json ?? {};
check('report OPENS with data (no infinite loading, no fake data)', ok(reportBefore) && !!rb.session?.id, `status=${reportBefore.status}`);
check('report has real carton section: 1 received + 1 missing', rb.cartons?.received?.length === 1 && rb.cartons?.missing?.length === 1,
  `received=${rb.cartons?.received?.length} missing=${rb.cartons?.missing?.length}`);
check('report carton line carries real identity (suivi code preserved)', rb.cartons?.received?.[0]?.carton?.suiviCode === `SUI-ACC-${UNIQ}-1`,
  JSON.stringify(rb.cartons?.received?.[0]));
check('report product lines: 2 CONFIRMED', rb.lines?.length === 2 && rb.lines?.every((l) => l.result === 'CONFIRMED'),
  JSON.stringify(rb.lines));
check('report totals are live real data (15 units expected)', rb.totals?.expectedUnits === 15, JSON.stringify(rb.totals));

// 9. Statuses must exist for DAMAGED too: declare damage on product1
const line1 = rb.lines?.find((l) => l.sku === SKU1);
const dmg = await call('POST', `/receiving/sessions/${sessionId}/lines/${line1.receivingProductId}/damage`, {
  token: workerToken, body: { quantity: 2, note: 'two damaged boxes ACC' },
});
check('damage declared (DAMAGED subset of scanned)', ok(dmg) && dmg.json?.verification?.result === 'DAMAGED',
  `status=${dmg.status} ${JSON.stringify(dmg.json).slice(0,200)}`);

// 10. Draft + submit
const draft = await call('PUT', `/receiving/sessions/${sessionId}/report`, {
  token: workerToken,
  body: { description: 'ACCEPTANCE TEST NOTE', observation: 'auto flow check', photos: [] },
});
check('report DRAFT saved', ok(draft) && draft.json?.reportStatus === 'DRAFT', `status=${draft.status} ${JSON.stringify(draft.json).slice(0,150)}`);

const sub = await call('POST', `/receiving/sessions/${sessionId}/report/submit`, {
  token: workerToken, body: {},
});
const sb = sub.json ?? {};
check('report SUBMITTED (locked)', ok(sub) && sb.reportStatus === 'SUBMITTED', `status=${sub.status} ${JSON.stringify(sb).slice(0,300)}`);
check('submitted report persisted product results (DAMAGED line exists)', sb.lines?.some((l) => l.result === 'DAMAGED' && l.damagedQuantity === 2),
  JSON.stringify(sb.lines));
check('submitted report totals persisted (receivedCartons=1, missingCartons=1)',
  sb.totals?.receivedCartons === 1 && sb.totals?.missingCartons === 1, JSON.stringify(sb.totals));
check('submitted report has date/time (submittedAt)', !!sb.submittedAt, `submittedAt=${sb.submittedAt}`);
check('submitted report has actor (worker+station)', !!sb.actor?.workerId && !!sb.actor?.stationCode, JSON.stringify(sb.actor));
check('report still opens after submit (locked read path)', sb.session?.id === sessionId);

// 11. Output B — Temporary Storage inbox contains ONLY confirmed product lines
const inbox = await call('GET', '/workflow/temporary-storage/inbox', { token: adminToken });
const items = (inbox.json?.items ?? []).filter((i) => i.session?.id === sessionId);
check('admin sees Temporary Storage inbox', ok(inbox) && inbox.json?.flow === 'PRODUCT', `status=${inbox.status}`);
// product1 is DAMAGED (2 of 10) -> nothing to hand over; product2 is CONFIRMED -> 1 move.
check('inbox has exactly the CONFIRMED product line (1 move, damaged line excluded)',
  items.length === 1 && items[0].product.sku === SKU2 && items[0].quantities.confirmed === 5,
  `items=${JSON.stringify(items.map((i) => [i.product.sku, i.quantities]))}`);
check('inbox item is a PRODUCT with sku + confirmedQuantity>0 (never a carton)',
  items.every((i) => i.product?.sku && !JSON.stringify(i).includes('CTN-ACC-')), JSON.stringify(items).slice(0, 400));
check('DAMAGED line did NOT move to Temporary Storage', !items.some((i) => i.product.sku === SKU1), JSON.stringify(items.map((i) => i.product.sku)));
check('inbox item carries session/arrival/handoff trace', items.every((i) => i.session?.id && i.arrival?.id && i.handoff?.at), JSON.stringify(items[0]).slice(0,300));

// 12. Temporary Storage intake (STAGING station accepts the move)
const stations = await call('GET', '/stations', { token: adminToken });
const stg = (stations.json ?? []).find((s) => s.code === 'ST-STG-01');
check('STAGING station ST-STG-01 exists (backend input contract ready)', !!stg, JSON.stringify(stations.json ?? []).slice(0,300));
if (items.length === 1 && stg) {
  const accept = await call('POST', '/workflow/temporary-storage/accept', {
    token: adminToken,
    body: { moveId: items[0].moveId, stationId: stg.id },
  });
  check('STAGING intake accepted the product move', ok(accept) && !!accept.json?.acceptedAt,
    `status=${accept.status} ${JSON.stringify(accept.json).slice(0,200)}`);
  const after = await call('GET', '/workflow/temporary-storage/inbox', { token: adminToken });
  const moved = (after.json?.items ?? []).find((i) => i.session?.id === sessionId);
  // Design: intake CLOSES the pending move (acceptedAt) but the logical
  // department stays STAGING until phase 3 appends a SORTING move.
  check('move ledger closed after intake (acceptedAt + accepted=true)',
    moved?.handoff?.accepted === true && !!moved?.handoff?.acceptedAt &&
    moved?.handoff?.station?.code === 'ST-STG-01',
    JSON.stringify(moved?.handoff).slice(0,300));
} else {
  check('STAGING intake accepted the product move', false, 'no move to accept');
  check('move ledger closed after intake (acceptedAt + accepted=true)', false, 'skipped');
}

console.log(`\nfailures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
