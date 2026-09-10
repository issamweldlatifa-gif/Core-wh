/* AYROVI — MASTER EXECUTION practical chain acceptance.
 *
 * Reference chain, one worker per station, real APIs only (no mock data):
 *
 *   Worker → Station → Operation → Work → Task
 *
 *   WORKER001 / ST-REC-01 / Receiving        / Verify SQ + products
 *   WORKER002 / ST-STG-01 / Temporary Storage/ Répartition et rangement temporaire
 *   WORKER003 / ST-SRT-01 / Sorting          / Tri par client
 *   WORKER004 / ST-PCK-01 / Packing          / Préparation de commande
 *   WORKER005 / ST-SHP-01 / Shipping-Dispatch/ Contrôle et expédition
 *
 * Flow covered end to end:
 *   CRM order + arrival + shipment
 *     -> Receiving scans + verification report (SUBMITTED)
 *     -> Temporary Storage intake (only CONFIRMED products)
 *     -> Temporary Storage station: product -> container (real ArticleUnits)
 *     -> Sorting: article -> customer container (tri par client)
 *     -> Packing: customer container -> Colis (outbound shipment)
 *     -> Shipping: Colis -> Expédition (verify + dispatch)
 *
 * Usage: BASE=https://host/api/v1 node acceptance-chain.mjs
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000/api/v1';
const API_KEY = process.env.INT_KEY ?? 'int_key_acceptance_123';
const ADMIN = { id: process.env.ADMIN_ID ?? 'ADMIN001', secret: process.env.ADMIN_SECRET ?? 'AdminPass!2026' };
const WORKER_SECRET = process.env.WORKER_SECRET ?? 'WorkerPass!2026';
const UNIQ = Date.now().toString(36).toUpperCase();
const ARRIVAL = `ARR-CH-${UNIQ}`;
const SHIPMENT = `SHP-CH-${UNIQ}`;
const CARTON = `CTN-CH-${UNIQ}-1`;
const ORDER = `ORD-CH-${UNIQ}`;
const ORDER_2 = `ORD-CH2-${UNIQ}`;
const CUSTOMER = 'Ahmed';
const CUSTOMER_2 = 'Bilel';
const SKU = `SKU-CH-${UNIQ}-1`;
const SKU_OTHER = `SKU-CH-${UNIQ}-2`;
const QTY = 3; // confirmed + ordered units -> one TS container, one customer container
const OTHER_QTY = 2; // second customer: proves "tri par client" routes by customer

let failures = 0;
let step = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}
function section(title) {
  step += 1;
  console.log(`\n${step}. ${title}`);
}
async function call(method, path, { token, key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['x-api-key'] = key;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const ok = (r) => r.status >= 200 && r.status < 300;
async function login(identifier, secret, app) {
  const r = await call('POST', '/auth/login', { body: { identifier, secret, app } });
  return { status: r.status, token: r.json?.accessToken, body: r.json };
}

console.log(`=== MASTER EXECUTION CHAIN — arrival ${ARRIVAL} / order ${ORDER} ===`);

// ---------------------------------------------------------------------------
section('Platform + admin session');
const health = await call('GET', '/system/health');
check('health endpoint', ok(health) && health.json?.database === 'up', `status=${health.status}`);
const admin = await login(ADMIN.id, ADMIN.secret, 'ADMIN_WEB');
check('admin login (ADMIN_WEB)', !!admin.token, `status=${admin.status} ${JSON.stringify(admin.body).slice(0, 150)}`);
const adminToken = admin.token;

// ---------------------------------------------------------------------------
section('MASTER EXECUTION floor: WORKER -> STATION binding (admin API)');
const floor = [
  ['WORKER001', 'ST-REC-01'],
  ['WORKER002', 'ST-STG-01'],
  ['WORKER003', 'ST-SRT-01'],
  ['WORKER004', 'ST-PCK-01'],
  ['WORKER005', 'ST-SHP-01'],
];
const stationList = await call('GET', '/stations', { token: adminToken });
const stationByCode = new Map((stationList.json ?? []).map((s) => [s.code, s]));
const usersList = await call('GET', '/users', { token: adminToken });
const userList = Array.isArray(usersList.json) ? usersList.json : usersList.json?.items ?? usersList.json?.data ?? [];
const userIdByCode = new Map(userList.map((u) => [u.employeeCode, u.id]));
for (const [workerCode, stationCode] of floor) {
  const st = stationByCode.get(stationCode);
  const workerId = userIdByCode.get(workerCode);
  const assigned = await call('POST', `/stations/${st?.id}/assign`, { token: adminToken, body: { workerId } });
  check(`${workerCode} bound to ${stationCode} (${st?.department})`, ok(assigned) && assigned.json?.assignedWorkerId === workerId,
    `status=${assigned.status} ${JSON.stringify(assigned.json).slice(0, 150)}`);
}

// ---------------------------------------------------------------------------
section('CRM push: order + arrival card + shipment card');
const orderPush = await call('POST', '/integrations/orders', {
  key: API_KEY,
  body: {
    externalOrderReference: ORDER,
    externalCustomerReference: 'AHMED',
    customerName: CUSTOMER,
    items: [
      { store: 'MAIN', externalProductCode: SKU, productName: `Product ${SKU}`, requestedQuantity: QTY, externalLineReference: 'L1' },
    ],
  },
});
check('CRM order accepted (customer container target)', ok(orderPush), `status=${orderPush.status} ${JSON.stringify(orderPush.json).slice(0, 200)}`);
const orderPush2 = await call('POST', '/integrations/orders', {
  key: API_KEY,
  body: {
    externalOrderReference: ORDER_2,
    externalCustomerReference: 'BILEL',
    customerName: CUSTOMER_2,
    items: [
      { store: 'MAIN', externalProductCode: SKU_OTHER, productName: `Product ${SKU_OTHER}`, requestedQuantity: OTHER_QTY, externalLineReference: 'L1' },
    ],
  },
});
check('second CRM order accepted (another customer)', ok(orderPush2), `status=${orderPush2.status}`);

const card = {
  event: 'customer_arrival_card.created',
  arrival: { id: ARRIVAL, reference: ARRIVAL },
  customer_arrival_card: {
    id: ARRIVAL,
    customer: { id: 'CUS-CH-TEST', name: CUSTOMER },
    store: { id: 'STORE-CH', name: 'Store CH' },
    products: [
      { sku: SKU, product_id: 'PRD-CH-1', product_name: `Product ${SKU}`, quantity: QTY, category: 'CLOTHING', subcategory: 'SHIRTS', classification_source: 'MANUAL' },
      { sku: SKU_OTHER, product_id: 'PRD-CH-2', product_name: `Product ${SKU_OTHER}`, quantity: OTHER_QTY, category: 'SHOES', subcategory: 'SNEAKERS', classification_source: 'MANUAL' },
    ],
  },
};
const pushArr = await call('POST', '/integrations/arrivals/customer-cards', { key: API_KEY, body: card });
check('CRM arrival card accepted', ok(pushArr), `status=${pushArr.status} ${JSON.stringify(pushArr.json).slice(0, 200)}`);
const arrivalId = pushArr.json?.warehouse_arrival_id ?? ARRIVAL;

const shipment = {
  event: 'shipment.created',
  arrival: { id: arrivalId, reference: ARRIVAL },
  shipment: {
    id: SHIPMENT,
    reference: SHIPMENT,
    source: { type: 'MANUAL', reference: 'chain-acc' },
    carrier: { id: 'DHL-CH', name: 'DHL CH', code: 'DHL' },
    tracking: { tracking_number: `TRK-CH-${UNIQ}`, status: 'IN_TRANSIT' },
    sender: { name: 'Sender CH', country: 'CN', city: 'Yiwu' },
    destination: { country: 'TN', city: 'Tunis', code: 'AYROVI-WH-TN' },
    summary: { total_cartons: 1, total_products: 2, total_units: QTY + OTHER_QTY },
    suivi_code: `SHP-SUI-CH-${UNIQ}`,
    cartons: [
      {
        id: CARTON,
        carton_number: 1,
        total_cartons: 1,
        entity_type: 'CARTON',
        suivi_code: `SUI-CH-${UNIQ}-1`,
        qr_code_value: `QR-CH-${UNIQ}-1`,
        source_project: 'CRM-CH',
        products: [
          { sku: SKU, product_name: `Product ${SKU}`, quantity: QTY },
          { sku: SKU_OTHER, product_name: `Product ${SKU_OTHER}`, quantity: OTHER_QTY },
        ],
      },
    ],
  },
};
const pushShp = await call('POST', '/integrations/arrivals/shipments', { key: API_KEY, body: shipment });
check('CRM shipment card accepted', ok(pushShp), `status=${pushShp.status} ${JSON.stringify(pushShp.json).slice(0, 200)}`);

// ---------------------------------------------------------------------------
section('WORKER001 @ ST-REC-01 — OPERATION Receiving (Vérifier SQ + produits)');
const w1 = await login('WORKER001', WORKER_SECRET, 'WORKER_NATIVE');
check('receiving worker login', !!w1.token, `status=${w1.status} ${JSON.stringify(w1.body).slice(0, 150)}`);
const recvToken = w1.token;
const ctx1 = await call('GET', '/terminal/context', { token: recvToken });
const tasks1 = (ctx1.json?.tasks ?? []).map((t) => t.key);
check('receiving worker is bound to a RECEIVING station', ctx1.json?.station?.code === 'ST-REC-01' && ctx1.json?.station?.department === 'RECEIVING',
  JSON.stringify(ctx1.json?.station));
check('receiving worker sees Receiving task (operation Receiving / Verify SQ + products)',
  tasks1.includes('receiving') && (ctx1.json?.tasks ?? []).find((t) => t.key === 'receiving')?.operation === 'Receiving',
  JSON.stringify(tasks1));
check('receiving worker does NOT see Temporary Storage (station gate)', !tasks1.includes('temporary-storage'), JSON.stringify(tasks1));
check('receiving worker does NOT see Packing/Shipping (station gate)',
  !tasks1.includes('packing') && !tasks1.includes('shipping'), JSON.stringify(tasks1));

const home = await call('GET', '/receiving/home', { token: recvToken });
check('worker home feed shows the CRM card (real work only)', ok(home) && JSON.stringify(home.json).includes(SKU),
  `status=${home.status}`);
const scanCarton = await call('POST', '/receiving/home/carton', {
  token: recvToken,
  body: { identifier: CARTON, identifierType: 'CARTON_REF', operationId: `op-ch-carton-${UNIQ}`, source: 'CAMERA' },
});
check('carton verified', ok(scanCarton) && scanCarton.json?.ok === true, `status=${scanCarton.status} ${JSON.stringify(scanCarton.json).slice(0, 200)}`);
const scanP1 = await call('POST', '/receiving/home/product', {
  token: recvToken,
  body: { identifier: SKU, quantity: QTY, operationId: `op-ch-p1-${UNIQ}`, source: 'CAMERA' },
});
check(`product ${SKU} verified (${QTY} units)`, ok(scanP1) && scanP1.json?.ok === true, `status=${scanP1.status} ${JSON.stringify(scanP1.json).slice(0, 200)}`);
const scanP2 = await call('POST', '/receiving/home/product', {
  token: recvToken,
  body: { identifier: SKU_OTHER, quantity: OTHER_QTY, operationId: `op-ch-p2-${UNIQ}`, source: 'CAMERA' },
});
check(`product ${SKU_OTHER} verified (${OTHER_QTY} units)`, ok(scanP2) && scanP2.json?.ok === true, `status=${scanP2.status} ${JSON.stringify(scanP2.json).slice(0, 200)}`);
const sessionId = scanCarton.json?.sessionId ?? scanP1.json?.sessionId;
check('receiving session created from the real scans', !!sessionId, `sessionId=${sessionId}`);

const sub = await call('POST', `/receiving/sessions/${sessionId}/report/submit`, { token: recvToken, body: {} });
check('receiving report SUBMITTED (confirmation)', ok(sub) && sub.json?.reportStatus === 'SUBMITTED',
  `status=${sub.status} ${JSON.stringify(sub.json).slice(0, 200)}`);

// ---------------------------------------------------------------------------
section('Receiving → Temporary Storage handoff (CONFIRMED products only)');
const inbox = await call('GET', '/workflow/temporary-storage/inbox', { token: adminToken });
const mine = (inbox.json?.items ?? []).filter((i) => i.session?.id === sessionId);
check('inbox carries ONLY products (never cartons)', mine.length > 0 && mine.every((i) => !!i.product?.sku), JSON.stringify(mine).slice(0, 300));
check('confirmed quantities match the receiving verification',
  mine.find((i) => i.product.sku === SKU)?.quantities?.confirmed === QTY &&
    mine.find((i) => i.product.sku === SKU_OTHER)?.quantities?.confirmed === OTHER_QTY,
  JSON.stringify(mine.map((i) => [i.product.sku, i.quantities])));
const stationsRes = await call('GET', '/stations', { token: adminToken });
const stg = (stationsRes.json ?? []).find((s) => s.code === 'ST-STG-01');
check('ST-STG-01 is an ACTIVE STAGING station', stg?.department === 'STAGING' && stg?.status === 'ACTIVE', JSON.stringify(stg).slice(0, 200));
for (const item of mine) {
  const accept = await call('POST', '/workflow/temporary-storage/accept', {
    token: adminToken,
    body: { moveId: item.moveId, stationId: stg.id },
  });
  check(`intake accepted ${item.product.sku} -> ST-STG-01`, ok(accept) && !!accept.json?.acceptedAt,
    `status=${accept.status} ${JSON.stringify(accept.json).slice(0, 150)}`);
}

// ---------------------------------------------------------------------------
section('WORKER002 @ ST-STG-01 — OPERATION Temporary Storage (Produit → Container)');
const w2 = await login('WORKER002', WORKER_SECRET, 'WORKER_NATIVE');
check('temporary storage worker login', !!w2.token, `status=${w2.status} ${JSON.stringify(w2.body).slice(0, 150)}`);
const tsToken = w2.token;
const ctx2 = await call('GET', '/terminal/context', { token: tsToken });
const tasks2 = (ctx2.json?.tasks ?? []).map((t) => t.key);
check('temporary storage worker bound to ST-STG-01 (STAGING)', ctx2.json?.station?.code === 'ST-STG-01', JSON.stringify(ctx2.json?.station));
check('worker picker shows Temporary Storage (operation + work)',
  tasks2.includes('temporary-storage') &&
    (ctx2.json?.tasks ?? []).find((t) => t.key === 'temporary-storage')?.work?.includes('Répartition'),
  JSON.stringify(tasks2));
check('worker picker does NOT show Receiving (station gate)', !tasks2.includes('receiving'), JSON.stringify(tasks2));

const tsHome = await call('GET', '/temporary-storage/home', { token: tsToken });
check('TS station home resolves the station + active products', ok(tsHome) && tsHome.json?.station?.code === 'ST-STG-01' && tsHome.json?.header?.activeProducts > 0,
  `status=${tsHome.status} ${JSON.stringify(tsHome.json?.header)}`);

const articles = [];
const containers = [];
for (const [sku, qty] of [[SKU, QTY], [SKU_OTHER, OTHER_QTY]]) {
  const scan = await call('POST', '/temporary-storage/scan', { token: tsToken, body: { operationId: `op-ch-ts-scan-${UNIQ}-${sku}`, code: sku } });
  check(`scan ${sku} -> VALID with resolved section + target container`,
    ok(scan) && scan.json?.status === 'VALID' && !!scan.json?.targetContainer?.code,
    `status=${scan.status} ${JSON.stringify(scan.json).slice(0, 250)}`);
  let target = scan.json?.targetContainer?.code;
  for (let i = 0; i < qty; i += 1) {
    const place = await call('POST', '/temporary-storage/place', {
      token: tsToken,
      body: { operationId: `op-ch-ts-place-${UNIQ}-${sku}-${i}`, code: sku, containerCode: target },
    });
    const j = place.json ?? {};
    if (place.status >= 200 && place.status < 300 && j.status === 'VALID') {
      if (j.article?.code) articles.push({ sku, code: j.article.code, container: j.container?.code });
      containers.push(j.container?.code);
      if (j.nextTarget?.code) target = j.nextTarget.code;
    } else {
      check(`place ${sku} #${i + 1} into ${target}`, false, `status=${place.status} ${JSON.stringify(j).slice(0, 250)}`);
      break;
    }
  }
}
check(`all ${QTY + OTHER_QTY} confirmed units placed (Produit → Container)`, articles.length === QTY + OTHER_QTY,
  `placed=${articles.length} ${JSON.stringify(articles)}`);
check('every placement materialized a REAL downstream ArticleUnit (bridge)', articles.every((a) => /^ART-/.test(a.code)),
  JSON.stringify(articles));

// ---------------------------------------------------------------------------
section('WORKER003 @ ST-SRT-01 — OPERATION Sorting (Tri par client: Customer Container → Produits)');
const w3 = await login('WORKER003', WORKER_SECRET, 'WORKER_NATIVE');
check('sorting worker login', !!w3.token, `status=${w3.status} ${JSON.stringify(w3.body).slice(0, 150)}`);
const sortToken = w3.token;
const ctx3 = await call('GET', '/terminal/context', { token: sortToken });
const tasks3 = (ctx3.json?.tasks ?? []).map((t) => t.key);
check('sorting worker bound to ST-SRT-01 (SORTING)', ctx3.json?.station?.code === 'ST-SRT-01', JSON.stringify(ctx3.json?.station));
check('sorting worker picker shows the sorting operations',
  tasks3.includes('order-sorting') || tasks3.includes('sorting'), JSON.stringify(tasks3));
check('sorting worker picker does NOT show Temporary Storage', !tasks3.includes('temporary-storage'), JSON.stringify(tasks3));

const binsByOrder = new Map();
let bin = null;
for (const a of articles) {
  const expectedOrder = a.sku === SKU ? ORDER : ORDER_2;
  const scan = await call('GET', `/fulfillment/order-sorting/articles/${a.code}`, { token: sortToken });
  const j = scan.json ?? {};
  if (!ok(scan)) {
    check(`sorting scan ${a.code}`, false, `status=${scan.status} ${JSON.stringify(j).slice(0, 250)}`);
    continue;
  }
  check(`sorting scan ${a.code} (${a.sku}) -> routed to customer order ${expectedOrder}`,
    j.kind === 'ASSIGNMENT' && j.order?.reference === expectedOrder, JSON.stringify(j).slice(0, 250));
  if (!binsByOrder.has(expectedOrder)) {
    if (j.bin?.code) {
      binsByOrder.set(expectedOrder, j.bin.code);
    } else {
      // The customer container is the SORTING operation's own object.
      const ensured = await call('POST', '/fulfillment/order-sorting/container', {
        token: sortToken,
        body: { orderReference: expectedOrder },
      });
      const code = ensured.json?.container?.code;
      check(`customer container opened for order ${expectedOrder} (sorting permission)`,
        ok(ensured) && !!code, `status=${ensured.status} ${JSON.stringify(ensured.json).slice(0, 200)}`);
      binsByOrder.set(expectedOrder, code);
    }
  }
  const binCode = binsByOrder.get(expectedOrder);
  if (expectedOrder === ORDER) bin = binCode;
  const assign = await call('POST', '/fulfillment/order-sorting/assign', {
    token: sortToken,
    body: { articleCode: a.code, containerCode: binCode },
  });
  check(`article ${a.code} (${a.sku}) placed in customer container ${binCode}`,
    ok(assign) && ['ARTICLE_ASSIGNED', 'BIN_READY_FOR_PACKING'].includes(assign.json?.flash?.kind),
    `status=${assign.status} ${JSON.stringify(assign.json).slice(0, 250)}`);
}
check('each customer has its own container (tri par client)', binsByOrder.size === 2 && binsByOrder.get(ORDER) !== binsByOrder.get(ORDER_2),
  JSON.stringify([...binsByOrder]));

// ---------------------------------------------------------------------------
section('WORKER004 @ ST-PCK-01 — OPERATION Packing (Customer Container → Colis)');
const w4 = await login('WORKER004', WORKER_SECRET, 'WORKER_NATIVE');
check('packing worker login', !!w4.token, `status=${w4.status} ${JSON.stringify(w4.body).slice(0, 150)}`);
const packToken = w4.token;
const ctx4 = await call('GET', '/terminal/context', { token: packToken });
check('packing worker bound to ST-PCK-01 (PACKING)', ctx4.json?.station?.code === 'ST-PCK-01', JSON.stringify(ctx4.json?.station));
check('packing worker picker shows Packing', (ctx4.json?.tasks ?? []).some((t) => t.key === 'packing'), JSON.stringify((ctx4.json?.tasks ?? []).map((t) => t.key)));

const packScan = await call('GET', `/fulfillment/packing/containers/${bin}`, { token: packToken });
check('packing scan shows the customer container, its order and completeness',
  ok(packScan) && packScan.json?.complete === true, `status=${packScan.status} ${JSON.stringify(packScan.json).slice(0, 300)}`);
check('the customer container really holds the sorted products',
  (packScan.json?.articles ?? []).length === QTY &&
    (packScan.json?.articles ?? []).every((a) => a.sku === SKU && a.status === 'IN_CUSTOMER_BIN'),
  JSON.stringify(packScan.json?.articles ?? []).slice(0, 300));
const packed = await call('POST', `/fulfillment/packing/containers/${bin}/pack`, { token: packToken });
const shipmentCode = packed.json?.shipment?.code;
check('customer container packed into a Colis (outbound shipment)',
  ok(packed) && packed.json?.flash?.kind === 'PACKED' && !!shipmentCode,
  `status=${packed.status} ${JSON.stringify(packed.json).slice(0, 250)}`);

// ---------------------------------------------------------------------------
section('WORKER005 @ ST-SHP-01 — OPERATION Shipping-Dispatch (Colis → Expédition)');
const w5 = await login('WORKER005', WORKER_SECRET, 'WORKER_NATIVE');
check('shipping worker login', !!w5.token, `status=${w5.status} ${JSON.stringify(w5.body).slice(0, 150)}`);
const shipToken = w5.token;
const ctx5 = await call('GET', '/terminal/context', { token: shipToken });
check('shipping worker bound to ST-SHP-01 (DISPATCH)', ctx5.json?.station?.code === 'ST-SHP-01', JSON.stringify(ctx5.json?.station));
check('shipping worker picker shows Shipping', (ctx5.json?.tasks ?? []).some((t) => t.key === 'shipping'), JSON.stringify((ctx5.json?.tasks ?? []).map((t) => t.key)));

const shipScan = await call('GET', `/fulfillment/shipping/shipments/${shipmentCode}`, { token: shipToken });
check('shipping scan resolves the Colis to a verification card', ok(shipScan) && !!shipScan.json, `status=${shipScan.status} ${JSON.stringify(shipScan.json).slice(0, 250)}`);
const verify = await call('POST', `/fulfillment/shipping/shipments/${shipmentCode}/verify`, { token: shipToken });
check('pre-dispatch verification created', ok(verify), `status=${verify.status} ${JSON.stringify(verify.json).slice(0, 200)}`);
const shipped = await call('POST', `/fulfillment/shipping/shipments/${shipmentCode}/ship`, { token: shipToken });
check('Colis EXPEDIE (SHIPPED)', ok(shipped) && JSON.stringify(shipped.json).includes('SHIPPED'),
  `status=${shipped.status} ${JSON.stringify(shipped.json).slice(0, 250)}`);

// ---------------------------------------------------------------------------
section('ADMIN WEB — same real workflow (who works where / operation / work / status)');
const board = await call('GET', '/operations/tasks', { token: adminToken });
const rows = board.json ?? [];
const rowOf = (k) => rows.find((r) => r.key === k);
check('task board exposes the reference operations with their WORK strings',
  ['receiving', 'temporary-storage', 'order-sorting', 'packing', 'shipping'].every((k) => !!rowOf(k)?.operation && !!rowOf(k)?.work),
  JSON.stringify(rows.map((r) => [r.key, r.operation, r.work])).slice(0, 400));
check('Temporary Storage row: operation= Temporary Storage, work= Répartition...',
  rowOf('temporary-storage')?.operation === 'Temporary Storage' && rowOf('temporary-storage')?.work?.includes('Répartition'),
  JSON.stringify(rowOf('temporary-storage')));
check('Sorting row (tri par client) present', rowOf('order-sorting')?.work === 'Tri par client (Customer Container → Produits)',
  JSON.stringify(rowOf('order-sorting')));
const workers = await call('GET', '/operations/workers', { token: adminToken });
const workerList = workers.json ?? [];
const w2row = workerList.find((w) => w.employeeCode === 'WORKER002');
check('worker list shows each worker with station + role', !!w2row?.station?.code && w2row.roles.includes('TEMP_STORAGE_WORKER'),
  JSON.stringify(w2row));
const detail = await call('GET', `/operations/workers/${w2row?.id}`, { token: adminToken });
const ops = detail.json?.worker?.operations ?? [];
check('worker drill-down lists the real OPERATIONS of that worker (registry-derived)',
  ops.some((o) => o.key === 'temporary-storage' && o.operation === 'Temporary Storage'),
  JSON.stringify(ops).slice(0, 300));
const overview = await call('GET', '/operations/overview', { token: adminToken });
check('control room overview answers 200 with pipeline + counters',
  ok(overview) && !!overview.json?.pipeline && !!overview.json?.counters, `status=${overview.status}`);
const binDetail = await call('GET', `/operations/containers/${bin}`, { token: adminToken });
check('admin container detail shows the dispatched customer container (cleanup state is honest)',
  ok(binDetail) && binDetail.json?.container?.status === 'CLOSED' && binDetail.json?.container?.order?.reference === ORDER,
  `status=${binDetail.status} ${JSON.stringify(binDetail.json?.container ?? binDetail.json).slice(0, 250)}`);
const shippedCard = await call('GET', `/fulfillment/shipping/shipments/${shipmentCode}`, { token: adminToken });
check('dispatched Colis still carries its customer + container traceability',
  ok(shippedCard) && JSON.stringify(shippedCard.json).includes(bin) && JSON.stringify(shippedCard.json).toUpperCase().includes('AHMED'),
  `status=${shippedCard.status} ${JSON.stringify(shippedCard.json).slice(0, 250)}`);
const shipmentsBoard = await call('GET', '/fulfillment/outbound-shipments', { token: adminToken });
check('admin shipments board lists the dispatched Colis',
  ok(shipmentsBoard) && JSON.stringify(shipmentsBoard.json).includes(shipmentCode),
  `status=${shipmentsBoard.status}`);

console.log(`\nfailures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
