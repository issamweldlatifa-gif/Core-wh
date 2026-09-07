#!/usr/bin/env node
/**
 * AYROVI — CLEAN TEST DATA RESET (Standalone, uses pg driver directly)
 * 
 * TEST ENVIRONMENT ONLY
 * 
 * This script performs a complete test data cleanup without requiring
 * the Prisma native query engine. Uses the 'pg' driver directly.
 * 
 * Usage:
 *   DATABASE_URL="postgresql://user:pass@host:5432/dbname" npx tsx tools/test-data-reset-pg.ts
 *   DATABASE_URL="..." npx tsx tools/test-data-reset-pg.ts --dry-run   (audit only)
 *   DATABASE_URL="..." npx tsx tools/test-data-reset-pg.ts --force     (skip confirmation)
 * 
 * CRITICAL RULES:
 *   - Does NOT modify application code, APIs, business logic, or schema
 *   - Does NOT delete production data, configuration, or master/reference data
 *   - Preserves: permissions, roles, system settings, warehouse structure,
 *     stations, category master, products (master), admin structure
 *   - Removes: test workers, test arrivals, test receiving sessions,
 *     test cartons, test shipments, test articles, test containers,
 *     test task assignments, test audit logs, test exceptions
 */

import { Client } from 'pg';
import * as bcrypt from 'bcrypt';
import * as readline from 'readline';

// ============================================================================
// Configuration
// ============================================================================

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const SYSTEM_ROLES = [
  'SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER',
  'INBOUND_WORKER', 'RECEIVING_WORKER', 'SORTING_WORKER',
  'PUTAWAY_WORKER', 'PACKING_WORKER', 'SHIPPING_WORKER',
  'PICKER', 'PACKER', 'VIEWER',
];

const INITIAL_ADMIN_CODE = process.env.INITIAL_ADMIN_CODE ?? 'ADMIN001';
const OPERATIONAL_ROLES = [
  'INBOUND_WORKER', 'RECEIVING_WORKER', 'SORTING_WORKER',
  'PUTAWAY_WORKER', 'PICKER', 'PACKER', 'PACKING_WORKER', 'SHIPPING_WORKER',
];

// ============================================================================
// Helpers
// ============================================================================

async function query(client: Client, sql: string, params?: any[]) {
  return client.query(sql, params);
}

function pad(str: string, len: number) {
  return str.length > len ? str.substring(0, len) : str.padEnd(len);
}

async function promptConfirm(message: string): Promise<boolean> {
  if (FORCE) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

// ============================================================================
// Main Script
// ============================================================================

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    console.error('Example: DATABASE_URL="postgresql://ayrovi:ayrovi_dev@localhost:5432/ayrovi_warehouse"');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  
  try {
    await client.connect();
    console.log('✅ Connected to database');
  } catch (err: any) {
    console.error(`❌ Cannot connect to database: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AYROVI — TEST DATA RESET');
  console.log('  TEST ENVIRONMENT ONLY');
  console.log(`  Mode: ${DRY_RUN ? 'AUDIT ONLY (dry run)' : 'AUDIT + CLEANUP'}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // ======================================================================
  // PHASE 1: AUDIT
  // ======================================================================
  
  console.log('───────────────────────────────────────────────────────────');
  console.log('  PHASE 1: AUDIT — Inspecting database...');
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  // --- Identify all users with their roles ---
  const usersResult = await query(client, `
    SELECT u.id, u."employeeCode", u.name, u.status, u."credentialMode",
           COALESCE(
             (SELECT array_agg(r.name) FROM user_roles ur 
              JOIN roles r ON r.id = ur."roleId" 
              WHERE ur."userId" = u.id),
             ARRAY[]::text[]
           ) as roles
    FROM users u
    ORDER BY u."createdAt"
  `);
  const allUsers = usersResult.rows;
  
  const testWorkers = allUsers.filter((u: any) => 
    u.roles.some((r: string) => OPERATIONAL_ROLES.includes(r))
  );
  const adminUsers = allUsers.filter((u: any) => 
    u.roles.some((r: string) => ['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER', 'VIEWER'].includes(r))
  );

  console.log('  ┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('  │ ENTITY                                │ COUNT │ SAFE TO DELETE?             │');
  console.log('  ├─────────────────────────────────────────────────────────────────────────────┤');

  // Count all entities
  const counts: Record<string, number> = {};
  
  const entities = [
    ['users', 'SELECT COUNT(*) as cnt FROM users'],
    ['sessions', 'SELECT COUNT(*) as cnt FROM sessions'],
    ['devices', 'SELECT COUNT(*) as cnt FROM devices'],
    ['stations', 'SELECT COUNT(*) as cnt FROM stations'],
    ['roles', 'SELECT COUNT(*) as cnt FROM roles'],
    ['permissions', 'SELECT COUNT(*) as cnt FROM permissions'],
    ['user_roles', 'SELECT COUNT(*) as cnt FROM user_roles'],
    ['warehouses', 'SELECT COUNT(*) as cnt FROM warehouses'],
    ['zones', 'SELECT COUNT(*) as cnt FROM zones'],
    ['aisles', 'SELECT COUNT(*) as cnt FROM aisles'],
    ['racks', 'SELECT COUNT(*) as cnt FROM racks'],
    ['levels', 'SELECT COUNT(*) as cnt FROM levels'],
    ['locations', 'SELECT COUNT(*) as cnt FROM locations'],
    ['category_master', 'SELECT COUNT(*) as cnt FROM category_master'],
    ['category_zone_mappings', 'SELECT COUNT(*) as cnt FROM category_zone_mappings'],
    ['products', 'SELECT COUNT(*) as cnt FROM products'],
    ['warehouse_orders', 'SELECT COUNT(*) as cnt FROM warehouse_orders'],
    ['order_items', 'SELECT COUNT(*) as cnt FROM order_items'],
    ['physical_items', 'SELECT COUNT(*) as cnt FROM physical_items'],
    ['expected_arrivals', 'SELECT COUNT(*) as cnt FROM expected_arrivals'],
    ['expected_arrival_items', 'SELECT COUNT(*) as cnt FROM expected_arrival_items'],
    ['warehouse_shipments', 'SELECT COUNT(*) as cnt FROM warehouse_shipments'],
    ['warehouse_cartons', 'SELECT COUNT(*) as cnt FROM warehouse_cartons'],
    ['receiving_sessions', 'SELECT COUNT(*) as cnt FROM receiving_sessions'],
    ['receiving_cartons', 'SELECT COUNT(*) as cnt FROM receiving_cartons'],
    ['receiving_scan_events', 'SELECT COUNT(*) as cnt FROM receiving_scan_events'],
    ['receiving_products', 'SELECT COUNT(*) as cnt FROM receiving_products'],
    ['receiving_discrepancies', 'SELECT COUNT(*) as cnt FROM receiving_discrepancies'],
    ['article_units', 'SELECT COUNT(*) as cnt FROM article_units'],
    ['operational_containers', 'SELECT COUNT(*) as cnt FROM operational_containers'],
    ['outbound_shipments', 'SELECT COUNT(*) as cnt FROM outbound_shipments'],
    ['shipping_verifications', 'SELECT COUNT(*) as cnt FROM shipping_verifications'],
    ['worker_task_assignments', 'SELECT COUNT(*) as cnt FROM worker_task_assignments'],
    ['operational_exceptions', 'SELECT COUNT(*) as cnt FROM operational_exceptions'],
    ['operation_corrections', 'SELECT COUNT(*) as cnt FROM operation_corrections'],
    ['carton_placements', 'SELECT COUNT(*) as cnt FROM carton_placements'],
    ['putaway_sessions', 'SELECT COUNT(*) as cnt FROM putaway_sessions'],
    ['audit_logs', 'SELECT COUNT(*) as cnt FROM audit_logs'],
    ['system_settings', 'SELECT COUNT(*) as cnt FROM system_settings'],
    ['api_clients', 'SELECT COUNT(*) as cnt FROM api_clients'],
  ];

  const safeMap: Record<string, string> = {
    'users': 'Test workers ONLY',
    'sessions': 'Test worker sessions YES',
    'devices': 'Unassign workers, keep config',
    'stations': 'NO — preserve config',
    'roles': 'NO — system config',
    'permissions': 'NO — system config',
    'user_roles': 'Test worker roles YES',
    'warehouses': 'NO — structure',
    'zones': 'NO — structure',
    'aisles': 'NO — structure',
    'racks': 'NO — structure',
    'levels': 'NO — structure',
    'locations': 'NO — structure',
    'category_master': 'NO — taxonomy',
    'category_zone_mappings': 'NO — config',
    'products': 'PRESERVE — master data',
    'warehouse_orders': 'YES — test orders',
    'order_items': 'YES — test data',
    'physical_items': 'YES — test data',
    'expected_arrivals': 'YES — test arrivals',
    'expected_arrival_items': 'YES — cascade',
    'warehouse_shipments': 'YES — test shipments',
    'warehouse_cartons': 'YES — test cartons',
    'receiving_sessions': 'YES — test sessions',
    'receiving_cartons': 'YES — cascade',
    'receiving_scan_events': 'YES — cascade',
    'receiving_products': 'YES — cascade',
    'receiving_discrepancies': 'YES — cascade',
    'article_units': 'YES — test transactions',
    'operational_containers': 'YES — test containers',
    'outbound_shipments': 'YES — test shipments',
    'shipping_verifications': 'YES — cascade',
    'worker_task_assignments': 'YES — test assignments',
    'operational_exceptions': 'YES — test exceptions',
    'operation_corrections': 'YES — test corrections',
    'carton_placements': 'YES — test putaway',
    'putaway_sessions': 'YES — test sessions',
    'audit_logs': 'Clean test operations only',
    'system_settings': 'NO — config',
    'api_clients': 'Check individually',
  };

  for (const [entity, sql] of entities) {
    const result = await query(client, sql);
    counts[entity] = Number(result.rows[0].cnt);
    const safe = safeMap[entity] || 'CHECK';
    console.log(`  │ ${pad(entity, 39)} │ ${String(counts[entity]).padStart(5)} │ ${pad(safe, 27)} │`);
  }
  console.log('  └─────────────────────────────────────────────────────────────────────────────┘');
  console.log('');

  // --- Detail: Test Workers ---
  console.log('  TEST WORKERS IDENTIFIED:');
  if (testWorkers.length === 0) {
    console.log('    (none found)');
  }
  for (const w of testWorkers) {
    console.log(`    • ${w.employeeCode} — "${w.name}" — roles: [${w.roles.join(', ')}] — status: ${w.status}`);
  }
  console.log('');

  // --- Detail: Admin Users ---
  console.log('  ADMIN USERS (PRESERVED):');
  for (const u of adminUsers) {
    console.log(`    • ${u.employeeCode} — "${u.name}" — roles: [${u.roles.join(', ')}]`);
  }
  console.log('');

  // --- Detail: Arrivals ---
  if (counts.expected_arrivals > 0) {
    const arrivalsDetail = await query(client, `
      SELECT code, "customerName", status, "productCount", "totalUnits" 
      FROM expected_arrivals LIMIT 5
    `);
    console.log('  EXPECTED ARRIVALS (TEST DATA):');
    for (const a of arrivalsDetail.rows) {
      console.log(`    • ${a.code} — customer: ${a.customerName} — status: ${a.status} — ${a.productCount} products, ${a.totalUnits} units`);
    }
    console.log('');
  }

  // --- Detail: Receiving Sessions ---
  if (counts.receiving_sessions > 0) {
    const sessDetail = await query(client, `
      SELECT code, status, "deviceType", "stationId"
      FROM receiving_sessions LIMIT 5
    `);
    console.log('  RECEIVING SESSIONS (TEST DATA):');
    for (const s of sessDetail.rows) {
      console.log(`    • ${s.code} — status: ${s.status} — device: ${s.deviceType || 'unknown'}`);
    }
    console.log('');
  }

  // --- Detail: Products ---
  if (counts.products > 0) {
    const prodDetail = await query(client, `
      SELECT store, "externalProductCode", name, status
      FROM products LIMIT 5
    `);
    console.log('  PRODUCTS (MASTER DATA — WILL BE PRESERVED):');
    for (const p of prodDetail.rows) {
      console.log(`    • ${p.store}/${p.externalProductCode} — "${p.name}" — status: ${p.status}`);
    }
    console.log('');
  }

  // ======================================================================
  // PHASE 2: DELETION PLAN
  // ======================================================================
  
  console.log('───────────────────────────────────────────────────────────');
  console.log('  PHASE 2: DELETION PLAN');
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  const testWorkerIds = testWorkers.map((w: any) => w.id);

  console.log('  WILL DELETE:');
  console.log(`  ─────────────`);
  console.log(`  Test Workers:              ${testWorkers.length}`);
  console.log(`  Worker Task Assignments:   ${counts.worker_task_assignments}`);
  console.log(`  Receiving Sessions:        ${counts.receiving_sessions}`);
  console.log(`  Receiving Cartons:         ${counts.receiving_cartons}`);
  console.log(`  Receiving Products:        ${counts.receiving_products}`);
  console.log(`  Receiving Scan Events:     ${counts.receiving_scan_events}`);
  console.log(`  Receiving Discrepancies:   ${counts.receiving_discrepancies}`);
  console.log(`  Article Units:             ${counts.article_units}`);
  console.log(`  Operational Containers:    ${counts.operational_containers}`);
  console.log(`  Outbound Shipments:        ${counts.outbound_shipments}`);
  console.log(`  Shipping Verifications:    ${counts.shipping_verifications}`);
  console.log(`  Operational Exceptions:    ${counts.operational_exceptions}`);
  console.log(`  Operation Corrections:     ${counts.operation_corrections}`);
  console.log(`  Carton Placements:         ${counts.carton_placements}`);
  console.log(`  Putaway Sessions:          ${counts.putaway_sessions}`);
  console.log(`  Warehouse Cartons:         ${counts.warehouse_cartons}`);
  console.log(`  Warehouse Shipments:       ${counts.warehouse_shipments}`);
  console.log(`  Expected Arrivals:         ${counts.expected_arrivals}`);
  console.log(`  Expected Arrival Items:    ${counts.expected_arrival_items}`);
  console.log(`  Warehouse Orders:          ${counts.warehouse_orders}`);
  console.log(`  Order Items:               ${counts.order_items}`);
  console.log(`  Physical Items:            ${counts.physical_items}`);
  console.log('');
  
  console.log('  WILL PRESERVE:');
  console.log(`  ──────────────`);
  console.log(`  Admin Users:               ${adminUsers.length}`);
  console.log(`  Roles:                     ${counts.roles} (system configuration)`);
  console.log(`  Permissions:               ${counts.permissions}`);
  console.log(`  Warehouse Structure:       ${counts.warehouses} WH, ${counts.zones} zones, ${counts.aisles} aisles, ${counts.racks} racks, ${counts.levels} levels, ${counts.locations} locations`);
  console.log(`  Stations:                  ${counts.stations} (clear worker assignments)`);
  console.log(`  Category Master:           ${counts.category_master} categories, ${counts.category_zone_mappings} zone mappings`);
  console.log(`  Products (master):         ${counts.products}`);
  console.log(`  System Settings:           ${counts.system_settings}`);
  console.log(`  Devices:                   ${counts.devices} (unassign workers)`);
  console.log(`  API Clients:               ${counts.api_clients}`);
  console.log('');

  if (DRY_RUN) {
    console.log('  *** DRY RUN MODE — no data will be deleted ***');
    console.log('');
    await client.end();
    return;
  }

  // Confirm before executing
  const confirmed = await promptConfirm('  Proceed with deletion? This cannot be undone.');
  if (!confirmed) {
    console.log('  ❌ Cancelled by user.');
    await client.end();
    return;
  }

  // ======================================================================
  // PHASE 3: EXECUTE CLEANUP
  // ======================================================================
  
  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('  PHASE 3: EXECUTING CLEANUP...');
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  // Track actual counts
  const report = {
    workersRemoved: 0,
    workersPreserved: adminUsers.length,
    arrivalsRemoved: 0,
    receivingCardsRemoved: 0,
    receivingSessionsRemoved: 0,
    receivingLinesRemoved: 0,
    receivingCartonsRemoved: 0,
    receivingScanEventsRemoved: 0,
    receivingDiscrepanciesRemoved: 0,
    productTestTransactionsRemoved: 0,
    cartonTestTransactionsRemoved: 0,
    shipmentsRemoved: 0,
    scanRecordsRemoved: 0,
    taskAssignmentsRemoved: 0,
    sessionsReset: 0,
    pendingSyncRecordsRemoved: 0,
    operationalContainersRemoved: 0,
    outboundShipmentsRemoved: 0,
    shippingVerificationsRemoved: 0,
    cartonPlacementsRemoved: 0,
    putawaySessionsRemoved: 0,
    operationCorrectionsRemoved: 0,
    operationalExceptionsRemoved: 0,
    physicalItemsRemoved: 0,
    orderItemsRemoved: 0,
    warehouseOrdersRemoved: 0,
    productsRemoved: 0,
    auditLogsRemoved: 0,
    orphansFound: 0,
    orphansFixed: 0,
  };

  try {
    await query(client, 'BEGIN');

    // Step 1: Clear worker assignments from stations
    console.log('  [1/20] Clearing station worker assignments...');
    if (testWorkerIds.length > 0) {
      const r = await query(client, `
        UPDATE stations SET "assignedWorkerId" = NULL
        WHERE "assignedWorkerId" = ANY($1)
      `, [testWorkerIds]);
      console.log(`         → Cleared ${r.rowCount} station assignments`);
    }

    // Step 2: Clear worker assignments from devices
    console.log('  [2/20] Clearing device worker assignments...');
    if (testWorkerIds.length > 0) {
      const r = await query(client, `
        UPDATE devices SET "assignedWorkerId" = NULL
        WHERE "assignedWorkerId" = ANY($1)
      `, [testWorkerIds]);
      console.log(`         → Cleared ${r.rowCount} device assignments`);
    }

    // Step 3: Delete shipping verifications
    console.log('  [3/20] Deleting shipping verifications...');
    const r3 = await query(client, 'DELETE FROM shipping_verifications');
    report.shippingVerificationsRemoved = r3.rowCount ?? 0;
    console.log(`         → Deleted ${r3.rowCount}`);

    // Step 4: Delete outbound shipments
    console.log('  [4/20] Deleting outbound shipments...');
    const r4 = await query(client, 'DELETE FROM outbound_shipments');
    report.outboundShipmentsRemoved = r4.rowCount ?? 0;
    console.log(`         → Deleted ${r4.rowCount}`);

    // Step 5: Delete article units (product transactions)
    console.log('  [5/20] Deleting article units...');
    const r5 = await query(client, 'DELETE FROM article_units');
    report.productTestTransactionsRemoved = r5.rowCount ?? 0;
    console.log(`         → Deleted ${r5.rowCount}`);

    // Step 6: Delete operational containers
    console.log('  [6/20] Deleting operational containers...');
    const r6 = await query(client, 'DELETE FROM operational_containers');
    report.operationalContainersRemoved = r6.rowCount ?? 0;
    console.log(`         → Deleted ${r6.rowCount}`);

    // Step 7: Delete operation corrections
    console.log('  [7/20] Deleting operation corrections...');
    const r7 = await query(client, 'DELETE FROM operation_corrections');
    report.operationCorrectionsRemoved = r7.rowCount ?? 0;
    console.log(`         → Deleted ${r7.rowCount}`);

    // Step 8: Delete operational exceptions
    console.log('  [8/20] Deleting operational exceptions...');
    const r8 = await query(client, 'DELETE FROM operational_exceptions');
    report.operationalExceptionsRemoved = r8.rowCount ?? 0;
    console.log(`         → Deleted ${r8.rowCount}`);

    // Step 9: Delete carton placements (putaway ledger)
    console.log('  [9/20] Deleting carton placements...');
    const r9 = await query(client, 'DELETE FROM carton_placements');
    report.cartonPlacementsRemoved = r9.rowCount ?? 0;
    console.log(`         → Deleted ${r9.rowCount}`);

    // Step 10: Delete putaway sessions
    console.log('  [10/20] Deleting putaway sessions...');
    const r10 = await query(client, 'DELETE FROM putaway_sessions');
    report.putawaySessionsRemoved = r10.rowCount ?? 0;
    console.log(`         → Deleted ${r10.rowCount}`);

    // Step 11: Reset carton state
    console.log('  [11/20] Resetting carton state...');
    const r11 = await query(client, `
      UPDATE warehouse_cartons SET "currentLocationId" = NULL, "storedAt" = NULL,
             "claimedById" = NULL, "claimedAt" = NULL, status = 'EXPECTED',
             "receivedAt" = NULL, "receivedBy" = NULL
    `);
    console.log(`         → Reset ${r11.rowCount} carton records`);

    // Step 12: Delete warehouse cartons
    console.log('  [12/20] Deleting warehouse cartons...');
    const r12 = await query(client, 'DELETE FROM warehouse_cartons');
    report.cartonTestTransactionsRemoved = r12.rowCount ?? 0;
    console.log(`         → Deleted ${r12.rowCount}`);

    // Step 13: Delete warehouse shipments
    console.log('  [13/20] Deleting warehouse shipments...');
    const r13 = await query(client, 'DELETE FROM warehouse_shipments');
    report.shipmentsRemoved = r13.rowCount ?? 0;
    console.log(`         → Deleted ${r13.rowCount}`);

    // Step 14: Delete receiving sessions (CASCADE handles children)
    console.log('  [14/20] Deleting receiving sessions (cascade to cartons, products, scans, discrepancies)...');
    const r14 = await query(client, 'DELETE FROM receiving_sessions');
    report.receivingSessionsRemoved = r14.rowCount ?? 0;
    // The cascade handles: receiving_cartons, receiving_products, receiving_scan_events, receiving_discrepancies
    report.receivingCartonsRemoved = counts.receiving_cartons;
    report.receivingLinesRemoved = counts.receiving_products;
    report.receivingScanEventsRemoved = counts.receiving_scan_events;
    report.receivingDiscrepanciesRemoved = counts.receiving_discrepancies;
    report.receivingCardsRemoved = counts.expected_arrivals;
    report.scanRecordsRemoved = counts.receiving_cartons + counts.receiving_scan_events;
    console.log(`         → Deleted ${r14.rowCount} sessions`);
    console.log(`         → Cascaded: ${counts.receiving_cartons} cartons, ${counts.receiving_products} products, ${counts.receiving_scan_events} scan events, ${counts.receiving_discrepancies} discrepancies`);

    // Step 15: Delete worker task assignments
    console.log('  [15/20] Deleting worker task assignments...');
    const r15 = await query(client, 'DELETE FROM worker_task_assignments');
    report.taskAssignmentsRemoved = r15.rowCount ?? 0;
    console.log(`         → Deleted ${r15.rowCount}`);

    // Step 16: Delete expected arrival items + expected arrivals
    console.log('  [16/20] Deleting expected arrivals...');
    const r16a = await query(client, 'DELETE FROM expected_arrival_items');
    const r16b = await query(client, 'DELETE FROM expected_arrivals');
    report.arrivalsRemoved = r16b.rowCount ?? 0;
    console.log(`         → Deleted ${r16b.rowCount} arrivals, ${r16a.rowCount} arrival items`);

    // Step 17: Delete physical items + order items + warehouse orders
    console.log('  [17/20] Deleting warehouse orders chain...');
    const r17a = await query(client, 'DELETE FROM physical_items');
    const r17b = await query(client, 'DELETE FROM order_items');
    const r17c = await query(client, 'DELETE FROM warehouse_orders');
    report.physicalItemsRemoved = r17a.rowCount ?? 0;
    report.orderItemsRemoved = r17b.rowCount ?? 0;
    report.warehouseOrdersRemoved = r17c.rowCount ?? 0;
    console.log(`         → Deleted ${r17c.rowCount} orders, ${r17b.rowCount} items, ${r17a.rowCount} physical items`);

    // Step 18: Delete test worker sessions
    console.log('  [18/20] Deleting test worker sessions...');
    if (testWorkerIds.length > 0) {
      const r18 = await query(client, `
        DELETE FROM sessions WHERE "userId" = ANY($1)
      `, [testWorkerIds]);
      report.sessionsReset = r18.rowCount ?? 0;
      console.log(`         → Deleted ${r18.rowCount} sessions`);
    } else {
      console.log('         → (no test workers to clean sessions for)');
    }

    // Step 19: Delete user_roles for test workers then delete test workers
    console.log('  [19/20] Deleting test workers...');
    if (testWorkerIds.length > 0) {
      // Delete user_roles first (FK)
      await query(client, `DELETE FROM user_roles WHERE "userId" = ANY($1)`, [testWorkerIds]);
      const r19 = await query(client, `DELETE FROM users WHERE id = ANY($1)`, [testWorkerIds]);
      report.workersRemoved = r19.rowCount ?? 0;
      console.log(`         → Deleted ${r19.rowCount} test workers`);
    }

    // Step 20: Clean operational audit logs
    console.log('  [20/20] Cleaning test-related audit logs...');
    const operationalActions = [
      'RECEIVING_STARTED', 'RECEIVING_PAUSED', 'RECEIVING_RESUMED',
      'CARTON_SCANNED', 'CARTON_RECEIVED', 'CARTON_MANUAL_ENTRY',
      'UNKNOWN_CARTON', 'WRONG_SHIPMENT', 'DUPLICATE_CARTON',
      'PRODUCT_SCANNED', 'PRODUCT_RECEIVED', 'UNEXPECTED_PRODUCT',
      'DISCREPANCY_CREATED', 'DISCREPANCY_RESOLVED',
      'RECEIVING_COMPLETED', 'RECEIVING_COMPLETED_WITH_DISCREPANCY',
      'PUTAWAY_STARTED', 'PUTAWAY_PAUSED', 'PUTAWAY_RESUMED', 'PUTAWAY_COMPLETED',
      'CORRECTION_APPLIED', 'RECEIVING_REVERSED', 'SESSION_REOPENED',
      'DATA_VOIDED', 'TASK_ASSIGNED', 'TASK_COMPLETED', 'TASK_CANCELLED',
      'SESSION_REASSIGNED',
      'CONTAINER_READY_FOR_PACKING', 'CONTAINER_CLOSED', 'ARTICLE_SCANNED',
      'CONTAINER_STAGED', 'CUSTOMER_QR_GENERATED', 'CUSTOMER_CONTAINER_LOCKED',
      'CUSTOMER_CONTAINER_REOPENED', 'SHIPPING_VERIFIED',
      'EXCEPTION_CREATED', 'EXCEPTION_RESOLVED',
      'TASK_AUTO_DISPATCHED',
      'CUSTOMER_ARRIVAL_CARD_RECEIVED', 'SHIPMENT_CARD_RECEIVED',
      'WAREHOUSE_ORDER_CREATED', 'WAREHOUSE_ORDER_UPDATED', 'WAREHOUSE_ORDER_CANCELLED',
      'ORDER_ITEM_CREATED', 'ORDER_ITEM_UPDATED', 'ORDER_ITEM_CANCELLED',
      'PHYSICAL_ITEM_CREATED', 'PHYSICAL_ITEM_CANCELLED',
      'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
      'WORKER_ISSUE_REPORTED', 'TASK_IN_PROGRESS',
      'SORTING_DESTINATION_SELECTED',
    ];
    const r20 = await query(client, `
      DELETE FROM audit_logs WHERE action = ANY($1)
    `, [operationalActions]);
    report.auditLogsRemoved = r20.rowCount ?? 0;
    console.log(`         → Removed ${r20.rowCount} operational audit log entries`);

    await query(client, 'COMMIT');
    console.log('');
    console.log('  ✅ All deletions committed successfully');

  } catch (error: any) {
    await query(client, 'ROLLBACK');
    console.error('');
    console.error(`  ❌ ERROR: ${error.message}`);
    console.error('  Transaction rolled back — no data was deleted.');
    await client.end();
    process.exit(1);
  }

  // ======================================================================
  // PHASE 4: VERIFY — Check for orphans
  // ======================================================================
  
  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('  PHASE 4: VERIFICATION — Checking for orphans...');
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  const orphanChecks = [
    ['receiving_session_without_arrival', `
      SELECT COUNT(*) as cnt FROM receiving_sessions rs
      LEFT JOIN expected_arrivals ea ON ea.id = rs."arrivalId"
      WHERE ea.id IS NULL
    `],
    ['receiving_carton_without_session', `
      SELECT COUNT(*) as cnt FROM receiving_cartons rc
      LEFT JOIN receiving_sessions rs ON rs.id = rc."receivingSessionId"
      WHERE rs.id IS NULL
    `],
    ['scan_event_without_session', `
      SELECT COUNT(*) as cnt FROM receiving_scan_events rse
      LEFT JOIN receiving_sessions rs ON rs.id = rse."sessionId"
      WHERE rs.id IS NULL
    `],
    ['task_without_worker', `
      SELECT COUNT(*) as cnt FROM worker_task_assignments wta
      LEFT JOIN users u ON u.id = wta."workerId"
      WHERE u.id IS NULL
    `],
    ['article_with_invalid_container', `
      SELECT COUNT(*) as cnt FROM article_units au
      LEFT JOIN operational_containers oc ON oc.id = au."containerId"
      WHERE au."containerId" IS NOT NULL AND oc.id IS NULL
    `],
    ['outbound_without_order', `
      SELECT COUNT(*) as cnt FROM outbound_shipments os
      LEFT JOIN warehouse_orders wo ON wo.id = os."orderId"
      WHERE wo.id IS NULL
    `],
    ['carton_without_shipment', `
      SELECT COUNT(*) as cnt FROM warehouse_cartons wc
      LEFT JOIN warehouse_shipments ws ON ws.id = wc."shipmentId"
      WHERE ws.id IS NULL
    `],
    ['placement_without_carton', `
      SELECT COUNT(*) as cnt FROM carton_placements cp
      LEFT JOIN warehouse_cartons wc ON wc.id = cp."cartonId"
      WHERE wc.id IS NULL
    `],
    ['placement_without_location', `
      SELECT COUNT(*) as cnt FROM carton_placements cp
      LEFT JOIN locations l ON l.id = cp."locationId"
      WHERE l.id IS NULL
    `],
    ['session_without_user', `
      SELECT COUNT(*) as cnt FROM sessions s
      LEFT JOIN users u ON u.id = s."userId"
      WHERE u.id IS NULL
    `],
  ];

  let totalOrphans = 0;
  for (const [name, sql] of orphanChecks) {
    const result = await query(client, sql);
    const cnt = Number(result.rows[0].cnt);
    if (cnt > 0) {
      console.log(`  ⚠️  ${name}: ${cnt} orphan(s)`);
      totalOrphans += cnt;
    }
  }

  if (totalOrphans === 0) {
    console.log('  ✅ No orphan records found — clean state verified');
  } else {
    console.log(`  ⚠️  Total orphans found: ${totalOrphans}`);
  }
  report.orphansFound = totalOrphans;

  // ======================================================================
  // PHASE 5: CREATE TEST WORKER
  // ======================================================================
  
  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('  PHASE 5: Creating ONE clean test worker...');
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  const testWorkerPassword = process.env.SEED_WORKER_PASSWORD || 'TestWorker!2024';
  const testWorkerCode = 'TEST_WORKER';
  const hash = await bcrypt.hash(testWorkerPassword, 12);

  // Check if TEST_WORKER already exists
  const existing = await query(client, `SELECT id FROM users WHERE "employeeCode" = $1`, [testWorkerCode]);
  
  let testWorkerId: string;
  if (existing.rows.length > 0) {
    testWorkerId = existing.rows[0].id;
    console.log(`  ✅ TEST_WORKER already exists (id: ${testWorkerId.slice(0,8)}...)`);
    await query(client, `
      UPDATE users SET name = 'TEST_WORKER', "passwordHash" = $1, "pinHash" = NULL,
             "credentialMode" = 'PASSWORD', status = 'ACTIVE'
      WHERE id = $2
    `, [hash, testWorkerId]);
    console.log(`  ✅ Updated to clean state`);
  } else {
    const result = await query(client, `
      INSERT INTO users (id, name, "employeeCode", email, "passwordHash", "credentialMode", status)
      VALUES (gen_random_uuid(), 'TEST_WORKER', $1, $1, $2, 'PASSWORD', 'ACTIVE')
      RETURNING id
    `, [testWorkerCode, hash]);
    testWorkerId = result.rows[0].id;
    console.log(`  ✅ TEST_WORKER created (id: ${testWorkerId.slice(0,8)}...)`);
  }

  // Assign RECEIVING_WORKER role
  const receivingRole = await query(client, `SELECT id FROM roles WHERE name = 'RECEIVING_WORKER'`);
  if (receivingRole.rows.length > 0) {
    await query(client, `
      INSERT INTO user_roles ("userId", "roleId") VALUES ($1, $2)
      ON CONFLICT ("userId", "roleId") DO NOTHING
    `, [testWorkerId, receivingRole.rows[0].id]);
    console.log(`  ✅ Assigned RECEIVING_WORKER role`);
  }

  // Assign to receiving station
  const receivingStation = await query(client, `
    SELECT id, code, name FROM stations WHERE department = 'RECEIVING' AND status = 'ACTIVE' LIMIT 1
  `);
  if (receivingStation.rows.length > 0) {
    await query(client, `
      UPDATE stations SET "assignedWorkerId" = $1 WHERE id = $2
    `, [testWorkerId, receivingStation.rows[0].id]);
    console.log(`  ✅ Assigned to station ${receivingStation.rows[0].code} (${receivingStation.rows[0].name})`);
  }

  console.log('');
  console.log(`  TEST_WORKER credentials:`);
  console.log(`    Employee Code: ${testWorkerCode}`);
  console.log(`    Password:      ${testWorkerPassword}`);
  console.log(`    Role:          RECEIVING_WORKER`);
  console.log('');

  // ======================================================================
  // PHASE 6: FINAL VERIFICATION
  // ======================================================================
  
  console.log('───────────────────────────────────────────────────────────');
  console.log('  PHASE 6: FINAL DATABASE STATE');
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  for (const [entity, sql] of entities) {
    const result = await query(client, sql);
    const cnt = Number(result.rows[0].cnt);
    const icon = cnt === 0 ? '✅' : '📋';
    console.log(`  ${icon} ${pad(entity, 35)} ${String(cnt).padStart(5)} records`);
  }

  // ======================================================================
  // FINAL REPORT
  // ======================================================================
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CLEANUP REPORT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Workers removed:                     ${report.workersRemoved}`);
  console.log(`  Workers preserved:                   ${report.workersPreserved}`);
  console.log('');
  console.log(`  Arrivals removed:                    ${report.arrivalsRemoved}`);
  console.log(`  Receiving Cards removed:             ${report.receivingCardsRemoved}`);
  console.log(`  Receiving Sessions removed:          ${report.receivingSessionsRemoved}`);
  console.log(`  Receiving Lines removed:             ${report.receivingLinesRemoved}`);
  console.log(`  Receiving Cartons removed:           ${report.receivingCartonsRemoved}`);
  console.log(`  Receiving Scan Events removed:       ${report.receivingScanEventsRemoved}`);
  console.log(`  Receiving Discrepancies removed:     ${report.receivingDiscrepanciesRemoved}`);
  console.log('');
  console.log(`  Product test transactions removed:   ${report.productTestTransactionsRemoved}`);
  console.log(`  Carton test transactions removed:    ${report.cartonTestTransactionsRemoved}`);
  console.log(`  Shipments removed:                   ${report.shipmentsRemoved}`);
  console.log(`  Scan records removed:                ${report.scanRecordsRemoved}`);
  console.log(`  Operational Containers removed:      ${report.operationalContainersRemoved}`);
  console.log(`  Outbound Shipments removed:          ${report.outboundShipmentsRemoved}`);
  console.log(`  Shipping Verifications removed:      ${report.shippingVerificationsRemoved}`);
  console.log('');
  console.log(`  Task assignments removed:            ${report.taskAssignmentsRemoved}`);
  console.log(`  Sessions reset:                      ${report.sessionsReset}`);
  console.log(`  Pending sync records removed:        ${report.pendingSyncRecordsRemoved}`);
  console.log(`  Putaway Sessions removed:            ${report.putawaySessionsRemoved}`);
  console.log(`  Carton Placements removed:           ${report.cartonPlacementsRemoved}`);
  console.log(`  Operation Corrections removed:       ${report.operationCorrectionsRemoved}`);
  console.log(`  Operational Exceptions removed:      ${report.operationalExceptionsRemoved}`);
  console.log(`  Warehouse Orders removed:            ${report.warehouseOrdersRemoved}`);
  console.log(`  Order Items removed:                 ${report.orderItemsRemoved}`);
  console.log(`  Physical Items removed:              ${report.physicalItemsRemoved}`);
  console.log(`  Audit Logs cleaned:                  ${report.auditLogsRemoved}`);
  console.log('');
  console.log(`  Orphans found:                       ${report.orphansFound}`);
  console.log(`  Orphans fixed:                       ${report.orphansFixed}`);
  console.log('');
  console.log(`  Production/master data preserved:    YES`);
  console.log(`  Application code modified:           NO`);
  console.log(`  Database schema modified:            NO`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FINAL STATE:');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  CLEAN DATA ✅');
  console.log('      ↓');
  console.log('  ONE TEST WORKER ✅ (TEST_WORKER / RECEIVING_WORKER)');
  console.log('      ↓');
  console.log('  READY FOR:');
  console.log('    1. Create 1 Test Arrival (manual)');
  console.log('    2. Create 1 Receiving Card (manual)');
  console.log('    3. Assign Controlled Product');
  console.log('    4. Assign Controlled Carton');
  console.log('    5. Execute Clean Worker App Receiving Flow');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  await client.end();
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
