/* AYROVI acceptance E2E (local): TEMPORARY STORAGE STATION — MASTER ORDER
 * tests §33 (45 products -> A1 20/20 FULL, A2 20/20 FULL, A3 5/20 ACTIVE),
 * §34 (wrong container), §23/§32 (carton never enters), §19/§36 (review
 * lane + exception + admin alert) and §21/§22 (Rapport de Fin -> admin).
 * No fake data: CRM push -> receiving -> verification -> handoff -> station.
 * Runs against http://127.0.0.1:3000 (dev DB). */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000/api/v1';
const API_KEY = process.env.INT_KEY ?? 'int_key_acceptance_123';
const UNIQ = Date.now().toString(36).toUpperCase();
const ARRIVAL = `ARR-TS-${UNIQ}`;
const SHIPMENT = `SHP-TS-${UNIQ}`;
const C1 = `CTN-TS-${UNIQ}-1`;
const CUSTOMER = 'Ahmed';
const CUSTOMER_SURNAME = 'Mohamed';
const SKU = `SKU-TS-${UNIQ}-1`;
const SKU_B = `SKU-TS-${UNIQ}-2`; // belongs to customer "Bilel" (letter B)
const SKU_UNKNOWN = `SKU-TS-${UNIQ}-X`;
const CAPACITY = 20;
const TOTAL = 45;

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

console.log(`=== TEMPORARY STORAGE ACCEPTANCE — arrival ${ARRIVAL} ===\n`);

// 0. health
const h = await call('GET', '/system/health');
check('health endpoint', ok(h), `status=${h.status}`);

// 1. admin login
const adminLogin = await call('POST', '/auth/login', {
  body: { identifier: 'ADMIN001', secret: 'AdminPass!2026', app: 'ADMIN_WEB' },
});
check('admin login', ok(adminLogin), `status=${adminLogin.status} ${JSON.stringify(adminLogin.json).slice(0, 200)}`);
const adminToken = adminLogin.json?.accessToken;
if (!adminToken) process.exit(1);
const cfgBase = await call('PUT', '/temporary-storage/admin/config', { token: adminToken, body: { capacity: 20 } });
check('capacity baseline = 20 (runtime config, not hardcoded)', ok(cfgBase) && cfgBase.json?.capacity === 20,
  `status=${cfgBase.status} ${JSON.stringify(cfgBase.json).slice(0, 120)}`);

// 2. Temporary Storage worker (created via the REAL admin users API) + station assignment
const tsCode = `TS${Date.now().toString(36).slice(-6).toUpperCase()}`;
const created = await call('POST', '/users', {
  token: adminToken,
  body: { name: 'TEMP STORAGE TEST WORKER', employeeCode: tsCode, email: `${tsCode}@test.local`, password: 'WorkerPass!2026', roles: ['RECEIVING_WORKER'], isActive: true },
});
check('admin created Temporary Storage worker', ok(created), `status=${created.status} ${JSON.stringify(created.json).slice(0, 300)}`);
const tsUserId = created.json?.id ?? created.json?.user?.id;
const stations = await call('GET', '/stations', { token: adminToken });
const stg = (stations.json ?? []).find((s) => s.code === 'ST-STG-01');
check('ST-STG-01 exists', !!stg, JSON.stringify(stations.json ?? []).slice(0, 200));
if (stg && tsUserId) {
  const assign = await call('POST', `/stations/${stg.id}/assign`, { token: adminToken, body: { workerId: tsUserId } });
  check('ST-STG-01 assigned to TS worker', ok(assign), `status=${assign.status} ${JSON.stringify(assign.json).slice(0, 200)}`);
}
// Baseline BEFORE this run pushes any product: the station header counts every
// accepted move on the floor, so the checks below are DELTA-based.
const preLogin = await call('POST', '/auth/login', { body: { identifier: tsCode, secret: 'WorkerPass!2026', app: 'WORKER_NATIVE' } });
const preHome = await call('GET', '/temporary-storage/home', { token: preLogin.json?.accessToken });
const baselineActive = preHome.json?.header?.activeProducts ?? 0;

// 3. CRM arrival cards: Ahmed (45 units) + Bilel (letter B test)
async function pushArrival(arrId, cus, sku, qty) {
  return call('POST', '/integrations/arrivals/customer-cards', {
    key: API_KEY,
    body: {
      event: 'customer_arrival_card.created',
      arrival: { id: arrId, reference: arrId },
      customer_arrival_card: {
        id: arrId,
        customer: { id: `CUS-${UNIQ}-${cus}`, name: cus },
        store: { id: 'STORE-TS', name: 'Store TS' },
        products: [{ sku, product_id: `PRD-${UNIQ}-${sku.slice(-2)}`, product_name: `${cus} Product ${sku.slice(-2)}`, quantity: qty, category: 'CLOTHING', subcategory: 'SHIRTS', classification_source: 'MANUAL' }],
      },
    },
  });
}
const pushA = await pushArrival(ARRIVAL, CUSTOMER, SKU, TOTAL);
check('CRM arrival card Ahmed accepted', ok(pushA), `status=${pushA.status} ${JSON.stringify(pushA.json).slice(0, 300)}`);
const arrivalId = pushA.json?.warehouse_arrival_id ?? ARRIVAL;
const pushB = await pushArrival(`ARR-TSB-${UNIQ}`, 'Bilel', SKU_B, 3);
check('CRM arrival card Bilel accepted', ok(pushB), `status=${pushB.status} ${JSON.stringify(pushB.json).slice(0, 300)}`);
const arrivalBId = pushB.json?.warehouse_arrival_id ?? `ARR-TSB-${UNIQ}`;

// shipment card with 1 carton (carton must never enter TS)
const pushShp = await call('POST', '/integrations/arrivals/shipments', {
  key: API_KEY,
  body: {
    event: 'shipment.created',
    arrival: { id: arrivalId, reference: ARRIVAL },
    shipment: {
      id: SHIPMENT, reference: SHIPMENT,
      source: { type: 'MANUAL', reference: 'manual-ts' },
      carrier: { id: 'DHL-TS', name: 'DHL', code: 'DHL' },
      tracking: { tracking_number: `TRK-TS-${UNIQ}`, status: 'IN_TRANSIT' },
      sender: { name: 'S', country: 'CN', city: 'Yiwu' },
      destination: { country: 'TN', city: 'Tunis', code: 'AYROVI-WH-TN' },
      summary: { total_cartons: 1, total_products: 1, total_units: TOTAL },
      suivi_code: `SUI-TS-${UNIQ}`,
      cartons: [
        { id: C1, carton_number: 1, total_cartons: 1, entity_type: 'CARTON', suivi_code: `SUI-TS-${UNIQ}-1`, qr_code_value: `QR-TS-${UNIQ}-1`, source_project: 'CRM-TS',
          products: [{ sku: SKU, product_name: 'Ahmed Product', quantity: TOTAL }] },
      ],
    },
  },
});
check('CRM shipment card accepted', ok(pushShp), `status=${pushShp.status}`);

// 4. Receiving worker scans the card (product full + carton) -> verification
const wl = await call('POST', '/auth/login', {
  body: { identifier: 'TEST_WORKER', secret: 'TestWorker!2024', app: 'WORKER_NATIVE' },
});
check('receiving worker login', ok(wl), `status=${wl.status}`);
const recvToken = wl.json?.accessToken;
const scanC = await call('POST', '/receiving/home/carton', {
  token: recvToken,
  body: { identifier: C1, identifierType: 'CARTON_REF', operationId: `op-ts-c1-${UNIQ}`, source: 'CAMERA' },
});
const sessionId = scanC.json?.sessionId;
const scanP = await call('POST', '/receiving/home/product', {
  token: recvToken,
  body: { identifier: SKU, quantity: TOTAL, operationId: `op-ts-p1-${UNIQ}`, source: 'CAMERA' },
});
check('receiving: carton + product scanned (session ready)', !!sessionId && ok(scanP), `session=${sessionId}`);
const scanPB = await call('POST', '/receiving/home/product', {
  token: recvToken,
  body: { identifier: SKU_B, quantity: 3, operationId: `op-ts-pb-${UNIQ}`, source: 'CAMERA' },
});
check('receiving: Bilel product scanned', ok(scanPB), `status=${scanPB.status} ${JSON.stringify(scanPB.json).slice(0, 200)}`);

// 5. Submit both verification reports (Bilel has its own session)
const repA = await call('GET', `/receiving/sessions/${sessionId}/report`, { token: recvToken });
const sessionB = scanPB.json?.sessionId ?? repA.json?.session?.id;
check('report Ahmed opens', ok(repA), `status=${repA.status}`);
const subA = await call('POST', `/receiving/sessions/${sessionId}/report/submit`, { token: recvToken, body: { description: 'TS ACCEPTANCE' } });
const subAjson = subA.json ?? {};
check('Ahmed report SUBMITTED + handoff ready', ok(subA) && subAjson.reportStatus === 'SUBMITTED' && !!subAjson.handoffReadyAt, `status=${subA.status} ${JSON.stringify(subAjson).slice(0, 200)}`);
const repB = await call('GET', `/receiving/sessions/${sessionB}/report`, { token: recvToken });
check('report Bilel opens', ok(repB), `status=${repB.status}`);
const subB = await call('POST', `/receiving/sessions/${sessionB}/report/submit`, { token: recvToken, body: {} });
check('Bilel report SUBMITTED', ok(subB), `status=${subB.status}`);

// 6. TS worker login + home
const tw = await call('POST', '/auth/login', { body: { identifier: tsCode, secret: 'WorkerPass!2026', app: 'WORKER_NATIVE' } });
check('TS worker login', ok(tw), `status=${tw.status} ${JSON.stringify(tw.json).slice(0, 200)}`);
const tsToken = tw.json?.accessToken;

const home = await call('GET', '/temporary-storage/home', { token: tsToken });
check('TS home header: +48 active products this run (45 Ahmed + 3 Bilel)', ok(home) && home.json?.header?.activeProducts === baselineActive + 48,
  `status=${home.status} baseline=${baselineActive} ${JSON.stringify(home.json?.header)}`);
const sec = home.json?.sections ?? [];
check('TS sections are DYNAMIC: only A and B (no static A-Z)', sec.map((s) => s.letter).join(',') === 'A,B',
  JSON.stringify(sec.map((s) => s.letter)));

// 7. Scan product -> system resolves customer/section/target
const scan1 = await call('POST', '/temporary-storage/scan', { token: tsToken, body: { operationId: `op-ts-scan-${UNIQ}`, code: SKU } });
check('scan product: VALID, customer Ahmed, section A, target container A1 (auto)',
  ok(scan1) && scan1.json?.status === 'VALID' && scan1.json?.product?.customer === CUSTOMER &&
  scan1.json?.product?.section === 'A' && scan1.json?.targetContainer?.code === 'A1' && scan1.json?.targetContainer?.mustCreate === true,
  JSON.stringify(scan1.json).slice(0, 300));

// 8. Place 45 units -> A1 20/20 FULL, A2 20/20 FULL, A3 5/20 ACTIVE (§33)
let target = 'A1';
const seen = new Map(); // code -> {current,capacity,status}
let placedOk = 0;
for (let i = 1; i <= TOTAL; i++) {
  const r = await call('POST', '/temporary-storage/place', {
    token: tsToken,
    body: { operationId: `op-ts-place-${UNIQ}-${i}`, code: SKU, containerCode: target },
  });
  const j = r.json ?? {};
  if (r.status >= 200 && r.status < 300 && (j.status === 'VALID')) {
    placedOk += 1;
    seen.set(j.container?.code, { current: j.container?.current, capacity: j.container?.capacity, status: j.container?.status });
    if (j.nextTarget) target = j.nextTarget.code;
    else if (j.container?.status === 'FULL') {
      // remaining should exist: system already opened next container
      target = j.nextTarget?.code ?? '';
    }
  } else {
    check(`place #${i} into ${target}`, false, `status=${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    break;
  }
}
check('all 45 confirmed units stored (VALID x45)', placedOk === TOTAL, `placedOk=${placedOk}`);
check('A1 = 20/20 FULL', seen.get('A1')?.current === 20 && seen.get('A1')?.status === 'FULL', JSON.stringify(seen.get('A1')));
check('A2 = 20/20 FULL', seen.get('A2')?.current === 20 && seen.get('A2')?.status === 'FULL', JSON.stringify(seen.get('A2')));
check('A3 = 5/20 ACTIVE', seen.get('A3')?.current === 5 && seen.get('A3')?.status === 'ACTIVE', JSON.stringify(seen.get('A3')));

// 9. Section board reflects reality
const secA = await call('GET', '/temporary-storage/sections/A', { token: tsToken });
const ahmed = secA.json?.customers?.find((c) => c.customer === CUSTOMER);
check('section A shows Ahmed with containers A1 A2 A3', ok(secA) && ahmed?.containers?.map((c) => c.code).join(',') === 'A1,A2,A3',
  JSON.stringify(secA.json?.customers).slice(0, 400));
check('A3 flagged as the ACTIVE target', ahmed?.containers?.find((c) => c.code === 'A3')?.active === true, JSON.stringify(ahmed?.containers));

// 10. WRONG CONTAINER (§34): Bilel product into Ahmed container A1
const wrong = await call('POST', '/temporary-storage/place', {
  token: tsToken,
  body: { operationId: `op-ts-wrong-${UNIQ}`, code: SKU_B, containerCode: 'A1' },
});
check('Bilel product + A1 -> WRONG_CONTAINER (no movement)', ok(wrong) && wrong.json?.status === 'WRONG_CONTAINER' &&
  wrong.json?.expected?.section === 'B', `status=${wrong.status} ${JSON.stringify(wrong.json).slice(0, 300)}`);
const secAAfter = await call('GET', '/temporary-storage/sections/A', { token: tsToken });
const ahmedAfter = secAAfter.json?.customers?.find((c) => c.customer === CUSTOMER);
check('A1 still 20/20 after wrong scan (nothing stored, nothing incremented)',
  ahmedAfter?.containers?.find((c) => c.code === 'A1')?.current === 20, JSON.stringify(ahmedAfter?.containers));
// Bilel now stores into B1 (correct target)
const bOk = await call('POST', '/temporary-storage/place', {
  token: tsToken,
  body: { operationId: `op-ts-b1-${UNIQ}`, code: SKU_B, containerCode: 'B1' },
});
check('Bilel product + B1 -> VALID (auto-created B1)', ok(bOk) && bOk.json?.status === 'VALID' && bOk.json?.container?.code === 'B1',
  JSON.stringify(bOk.json).slice(0, 200));

// 11. CARTON never enters TS (§23/§32): scan the carton at the station
const cartonScan = await call('POST', '/temporary-storage/scan', { token: tsToken, body: { operationId: `op-ts-ctn-${UNIQ}`, code: C1 } });
check('carton scan at TS -> CARTON_NOT_ALLOWED', ok(cartonScan) && cartonScan.json?.status === 'CARTON_NOT_ALLOWED',
  JSON.stringify(cartonScan.json).slice(0, 200));
const cartonPlace = await call('POST', '/temporary-storage/place', {
  token: tsToken,
  body: { operationId: `op-ts-ctn2-${UNIQ}`, code: C1, containerCode: 'A1' },
});
check('carton place attempt -> CARTON_NOT_ALLOWED (A1 untouched)', ok(cartonPlace) && cartonPlace.json?.status === 'CARTON_NOT_ALLOWED',
  JSON.stringify(cartonPlace.json).slice(0, 200));

// 12. REVIEW lane (§19/§36): unknown product -> review + exception + alert
const rev = await call('POST', '/temporary-storage/review', { token: tsToken, body: { operationId: `op-ts-rev-${UNIQ}`, code: SKU_UNKNOWN, reason: 'Damaged packaging — cannot be stored' } });
check('unknown product -> REVIEW + exception code', ok(rev) && rev.json?.status === 'REVIEW' && !!rev.json?.review?.exceptionCode,
  `status=${rev.status} ${JSON.stringify(rev.json).slice(0, 300)}`);
const overview = await call('GET', '/temporary-storage/admin/overview', { token: adminToken });
check('admin overview shows the review item + open review', ok(overview) && overview.json?.reviewItems?.some((r) => r.reason?.includes('Damaged')),
  JSON.stringify(overview.json?.reviewItems ?? []).slice(0, 300));
const exc = await call('GET', '/fulfillment/exceptions', { token: adminToken });
check('admin exceptions board contains the TEMPORARY_STORAGE_REVIEW exception', ok(exc) && JSON.stringify(exc.json).includes('TEMPORARY_STORAGE_REVIEW'),
  `status=${exc.status} ${JSON.stringify(exc.json).slice(0, 300)}`);

// 13. Rapport de Fin (§21) -> Admin Reports (§22)
const rdf = await call('POST', '/temporary-storage/report', { token: tsToken, body: { observation: 'Shift closed — acceptance run' } });
check('Rapport de Fin SUBMITTED', ok(rdf) && rdf.json?.status === 'SUBMITTED', `status=${rdf.status} ${JSON.stringify(rdf.json).slice(0, 300)}`);
const reps = await call('GET', '/temporary-storage/admin/reports', { token: adminToken });
const repRow = (reps.json ?? []).find((r) => r.id === rdf.json?.id);
check('admin reports list shows the Rapport de Fin', !!repRow && repRow.totals?.productsStored === 46, JSON.stringify(reps.json).slice(0, 300));
const repDetail = await call('GET', `/temporary-storage/admin/reports/${rdf.json?.id}`, { token: adminToken });
check('report detail has sections + worker + station + date/time', ok(repDetail) && repDetail.json?.sectionsProcessed?.length >= 2 && !!repDetail.json?.finishedAt,
  JSON.stringify(repDetail.json).slice(0, 400));
const rv = await call('POST', `/temporary-storage/admin/reports/${rdf.json?.id}/review`, { token: adminToken, body: { note: 'ok' } });
check('admin reviewed the report (REVIEWED)', ok(rv) && rv.json?.status === 'REVIEWED', JSON.stringify(rv.json).slice(0, 200));

// 14. Capacity is configuration (§13): change it and read it back
const cfg = await call('PUT', '/temporary-storage/admin/config', { token: adminToken, body: { capacity: 10 } });
check('admin set capacity = 10', ok(cfg) && cfg.json?.capacity === 10, JSON.stringify(cfg.json));
const cfg2 = await call('GET', '/temporary-storage/admin/config', { token: adminToken });
check('capacity read back as 10 (runtime config, no code change)', cfg2.json?.capacity === 10, JSON.stringify(cfg2.json));

// 15. Duplicate protection (§32): replay same operationId must not double-store
const dup = await call('POST', '/temporary-storage/place', {
  token: tsToken,
  body: { operationId: `op-ts-place-${UNIQ}-1`, code: SKU, containerCode: 'A1' },
});
check('same operationId replay -> already stored, NO double count', ok(dup) && (dup.json?.alreadyStored === true || dup.json?.status === 'ALREADY_STORED'),
  `status=${dup.status} ${JSON.stringify(dup.json).slice(0, 200)}`);

console.log(`\nfailures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
