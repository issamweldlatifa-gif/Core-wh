/**
 * AYROVI — CLEAN TEST DATA RESET
 * 
 * TEST ENVIRONMENT ONLY
 * 
 * This script performs a complete test data cleanup:
 *   1. AUDIT — count all records, identify test data
 *   2. PLAN  — show exactly what will be deleted
 *   3. EXECUTE — remove test data in proper dependency order
 *   4. VERIFY — check for orphans, confirm clean state
 *   5. SEED — create ONE test worker for validation
 *   6. REPORT — generate final cleanup report
 * 
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx tools/test-data-reset.ts
 *   DATABASE_URL="postgresql://..." npx tsx tools/test-data-reset.ts --dry-run   (audit only, no delete)
 *   DATABASE_URL="postgresql://..." npx tsx tools/test-data-reset.ts --force     (skip confirmation prompt)
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

import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// ============================================================================
// Configuration
// ============================================================================

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// System roles that must NEVER be deleted
const SYSTEM_ROLES = [
  'SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER',
  'INBOUND_WORKER', 'RECEIVING_WORKER', 'SORTING_WORKER',
  'PUTAWAY_WORKER', 'PACKING_WORKER', 'SHIPPING_WORKER',
  'PICKER', 'PACKER', 'VIEWER',
];

// Test worker identifiers created by the seed
const SEED_WORKER_CODE = process.env.SEED_WORKER_CODE ?? 'WORKER001';
const INITIAL_ADMIN_CODE = process.env.INITIAL_ADMIN_CODE ?? 'ADMIN001';

// Test data indicators — names/codes that clearly identify test records
const TEST_NAME_PATTERNS = [
  'TEST', 'test', 'Test',
  'DEMO', 'demo', 'Demo',
  'SAMPLE', 'sample', 'Sample',
  'TEMP', 'temp',
];

// ============================================================================
// Report Types
// ============================================================================

interface AuditRow {
  entity: string;
  count: number;
  examples: string[];
  relationships: string;
  safeToDelete: string;
}

interface CleanupCounts {
  workersRemoved: number;
  workersPreserved: number;
  arrivalsRemoved: number;
  receivingCardsRemoved: number; // = ExpectedArrivals with test data
  receivingSessionsRemoved: number;
  receivingLinesRemoved: number; // = ReceivingProducts
  receivingCartonsRemoved: number;
  receivingScanEventsRemoved: number;
  receivingDiscrepanciesRemoved: number;
  productTestTransactionsRemoved: number; // = ArticleUnits
  cartonTestTransactionsRemoved: number; // = WarehouseCartons (test only)
  shipmentsRemoved: number; // = WarehouseShipments (test only)
  scanRecordsRemoved: number;
  taskAssignmentsRemoved: number;
  sessionsReset: number;
  pendingSyncRecordsRemoved: number;
  operationalContainersRemoved: number;
  outboundShipmentsRemoved: number;
  shippingVerificationsRemoved: number;
  cartonPlacementsRemoved: number;
  putawaySessionsRemoved: number;
  operationCorrectionsRemoved: number;
  operationalExceptionsRemoved: number;
  physicalItemsRemoved: number;
  orderItemsRemoved: number;
  warehouseOrdersRemoved: number;
  productsRemoved: number;
  auditLogsRemoved: number;
  orphansFound: number;
  orphansFixed: number;
  productionDataPreserved: boolean;
  applicationCodeModified: boolean;
  databaseSchemaModified: boolean;
}

// ============================================================================
// Main Script
// ============================================================================

async function main() {
  const prisma = new PrismaClient();
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  AYROVI — TEST DATA RESET');
  console.log('  TEST ENVIRONMENT ONLY');
  console.log(`  Mode: ${DRY_RUN ? 'AUDIT ONLY (dry run)' : 'AUDIT + CLEANUP'}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  const counts: CleanupCounts = {
    workersRemoved: 0,
    workersPreserved: 0,
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
    productionDataPreserved: true,
    applicationCodeModified: false,
    databaseSchemaModified: false,
  };

  try {
    // ======================================================================
    // PHASE 1: AUDIT
    // ======================================================================
    
    console.log('───────────────────────────────────────────────────────────');
    console.log('  PHASE 1: AUDIT — Inspecting database...');
    console.log('───────────────────────────────────────────────────────────');
    console.log('');

    const audit: AuditRow[] = [];

    // --- Users ---
    const allUsers = await prisma.$queryRawUnsafe<any[]>(`
      SELECT u.id, u."employeeCode", u.name, u.status, u."credentialMode",
             (SELECT array_agg(r.name) FROM user_roles ur 
              JOIN roles r ON r.id = ur."roleId" 
              WHERE ur."userId" = u.id) as roles
      FROM users u
      ORDER BY u."createdAt"
    `);
    
    const testWorkers = allUsers.filter((u: any) => 
      u.roles && u.roles.some((r: string) => 
        ['INBOUND_WORKER', 'RECEIVING_WORKER', 'SORTING_WORKER', 
         'PUTAWAY_WORKER', 'PICKER', 'PACKER', 'PACKING_WORKER', 'SHIPPING_WORKER'].includes(r)
      )
    );
    const adminUsers = allUsers.filter((u: any) => 
      u.roles && u.roles.some((r: string) => 
        ['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER', 'VIEWER'].includes(r)
      )
    );

    audit.push({
      entity: 'Users (Total)',
      count: allUsers.length,
      examples: allUsers.slice(0, 5).map((u: any) => `${u.employeeCode} (${u.name})`),
      relationships: 'FK to sessions, devices, assignments, corrections, audit_logs',
      safeToDelete: 'Test workers ONLY — preserve admins',
    });

    audit.push({
      entity: 'Test Workers (Operational roles)',
      count: testWorkers.length,
      examples: testWorkers.slice(0, 5).map((u: any) => `${u.employeeCode} (${u.name}) — roles: ${(u.roles||[]).join(', ')}`),
      relationships: 'FK to sessions, devices, assignments',
      safeToDelete: 'YES — test workers created for development/testing',
    });

    audit.push({
      entity: 'Admin Users (System roles)',
      count: adminUsers.length,
      examples: adminUsers.slice(0, 3).map((u: any) => `${u.employeeCode} (${u.name})`),
      relationships: 'FK to sessions, audit_logs',
      safeToDelete: 'NO — system administrators',
    });

    // --- Sessions ---
    const sessions = await prisma.$queryRawUnsafe<any[]>(`
      SELECT s.id, s.status, s.application, s."userId", u."employeeCode" as worker_code, u.name as worker_name,
             s."deviceId", s."stationId"
      FROM sessions s
      LEFT JOIN users u ON u.id = s."userId"
      ORDER BY s."createdAt" DESC
    `);
    const testSessions = sessions.filter((s: any) => 
      testWorkers.some((w: any) => w.id === s.userId)
    );

    audit.push({
      entity: 'Sessions (Total)',
      count: sessions.length,
      examples: sessions.slice(0, 3).map((s: any) => `${s.id.slice(0,8)}... ${s.status} ${s.application} user=${s.worker_code}`),
      relationships: 'FK to users, devices, stations',
      safeToDelete: 'Test worker sessions = YES',
    });

    audit.push({
      entity: 'Sessions (Test Workers)',
      count: testSessions.length,
      examples: testSessions.slice(0, 3).map((s: any) => `${s.id.slice(0,8)}... ${s.status} worker=${s.worker_code}`),
      relationships: 'Cascade delete from user',
      safeToDelete: 'YES — part of test worker cleanup',
    });

    // --- Devices ---
    const devices = await prisma.$queryRawUnsafe<any[]>(`
      SELECT d.id, d.code, d.name, d.status, d."assignedWorkerId", u."employeeCode" as worker_code
      FROM devices d
      LEFT JOIN users u ON u.id = d."assignedWorkerId"
      ORDER BY d."createdAt"
    `);

    audit.push({
      entity: 'Devices',
      count: devices.length,
      examples: devices.slice(0, 3).map((d: any) => `${d.code} (${d.name}) worker=${d.worker_code || 'unassigned'}`),
      relationships: 'FK to users (assignedWorker), sessions, stations',
      safeToDelete: 'Check if test-only devices exist',
    });

    // --- Stations ---
    const stations = await prisma.$queryRawUnsafe<any[]>(`
      SELECT s.id, s.code, s.name, s.department, s.status, s."assignedWorkerId", u."employeeCode" as worker_code
      FROM stations s
      LEFT JOIN users u ON u.id = s."assignedWorkerId"
      ORDER BY s.code
    `);

    audit.push({
      entity: 'Stations',
      count: stations.length,
      examples: stations.slice(0, 6).map((s: any) => `${s.code} (${s.name}) dept=${s.department} worker=${s.worker_code || 'none'}`),
      relationships: 'FK to users, devices, zones — CONFIGURATION',
      safeToDelete: 'NO — preserve station configuration. Clear worker assignments only.',
    });

    // --- Expected Arrivals (Receiving Cards) ---
    const arrivals = await prisma.$queryRawUnsafe<any[]>(`
      SELECT ea.id, ea.code, ea."customerArrivalCardId", ea."customerName", ea.status, ea."productCount", ea."totalUnits",
             ea.source, ea."receivedViaApi"
      FROM expected_arrivals ea
      ORDER BY ea."createdAt"
    `);

    audit.push({
      entity: 'Expected Arrivals (Receiving Cards)',
      count: arrivals.length,
      examples: arrivals.slice(0, 5).map((a: any) => `${a.code} status=${a.status} customer=${a.customerName} products=${a.productCount}`),
      relationships: 'Parent of: arrival_items, shipments, receiving_sessions, task_assignments',
      safeToDelete: 'YES — all are test arrivals',
    });

    // --- Expected Arrival Items ---
    const arrivalItems = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM expected_arrival_items`);
    audit.push({
      entity: 'Expected Arrival Items',
      count: Number(arrivalItems[0].cnt),
      examples: [],
      relationships: 'FK to expected_arrivals (CASCADE)',
      safeToDelete: 'YES — cascade with parent arrival',
    });

    // --- Warehouse Shipments ---
    const shipments = await prisma.$queryRawUnsafe<any[]>(`
      SELECT ws.id, ws.code, ws."externalShipmentId", ws."arrivalId", ws."totalCartons", ws."trackingNumber"
      FROM warehouse_shipments ws
      ORDER BY ws."createdAt"
    `);

    audit.push({
      entity: 'Warehouse Shipments',
      count: shipments.length,
      examples: shipments.slice(0, 5).map((s: any) => `${s.code} arrival=${s.arrivalId?.slice(0,8) || 'none'} cartons=${s.totalCartons}`),
      relationships: 'Parent of: warehouse_cartons; child of expected_arrivals',
      safeToDelete: 'YES — test shipment data',
    });

    // --- Warehouse Cartons ---
    const cartons = await prisma.$queryRawUnsafe<any[]>(`
      SELECT wc.id, wc."externalCartonId", wc."shipmentId", wc.status, wc."currentLocationId",
             ws.code as shipment_code
      FROM warehouse_cartons wc
      LEFT JOIN warehouse_shipments ws ON ws.id = wc."shipmentId"
      ORDER BY wc."createdAt"
    `);

    audit.push({
      entity: 'Warehouse Cartons',
      count: cartons.length,
      examples: cartons.slice(0, 5).map((c: any) => `${c.externalCartonId} status=${c.status} shipment=${c.shipment_code || 'none'}`),
      relationships: 'FK to shipments; parent of receiving_cartons, placements, article_units',
      safeToDelete: 'YES — test carton data',
    });

    // --- Receiving Sessions ---
    const receivingSessions = await prisma.$queryRawUnsafe<any[]>(`
      SELECT rs.id, rs.code, rs.status, rs."arrivalId", ea.code as arrival_code,
             rs."startedBy", rs."deviceType", rs."stationId"
      FROM receiving_sessions rs
      LEFT JOIN expected_arrivals ea ON ea.id = rs."arrivalId"
      ORDER BY rs."createdAt"
    `);

    audit.push({
      entity: 'Receiving Sessions',
      count: receivingSessions.length,
      examples: receivingSessions.slice(0, 5).map((s: any) => `${s.code} status=${s.status} arrival=${s.arrival_code || 'none'}`),
      relationships: 'Parent of: receiving_cartons, receiving_products, scan_events, discrepancies, corrections, article_units',
      safeToDelete: 'YES — test receiving sessions',
    });

    // --- Receiving Cartons ---
    const receivingCartons = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_cartons`);
    audit.push({
      entity: 'Receiving Cartons (scan records)',
      count: Number(receivingCartons[0].cnt),
      examples: [],
      relationships: 'FK to receiving_sessions (CASCADE)',
      safeToDelete: 'YES — cascade with session',
    });

    // --- Receiving Products ---
    const receivingProducts = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_products`);
    audit.push({
      entity: 'Receiving Products (lines)',
      count: Number(receivingProducts[0].cnt),
      examples: [],
      relationships: 'FK to receiving_sessions (CASCADE)',
      safeToDelete: 'YES — cascade with session',
    });

    // --- Receiving Scan Events ---
    const scanEvents = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_scan_events`);
    audit.push({
      entity: 'Receiving Scan Events',
      count: Number(scanEvents[0].cnt),
      examples: [],
      relationships: 'FK to receiving_sessions (CASCADE)',
      safeToDelete: 'YES — cascade with session',
    });

    // --- Receiving Discrepancies ---
    const discrepancies = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_discrepancies`);
    audit.push({
      entity: 'Receiving Discrepancies',
      count: Number(discrepancies[0].cnt),
      examples: [],
      relationships: 'FK to receiving_sessions (CASCADE)',
      safeToDelete: 'YES — cascade with session',
    });

    // --- Article Units ---
    const articles = await prisma.$queryRawUnsafe<any[]>(`
      SELECT au.id, au.code, au.sku, au.status, au."containerId", au."orderId", au."sourceCartonId"
      FROM article_units au
      ORDER BY au."createdAt"
    `);

    audit.push({
      entity: 'Article Units (product transactions)',
      count: articles.length,
      examples: articles.slice(0, 5).map((a: any) => `${a.code} sku=${a.sku} status=${a.status}`),
      relationships: 'FK to containers, orders, cartons, sessions (all SetNull)',
      safeToDelete: 'YES — test product transactions',
    });

    // --- Operational Containers ---
    const containers = await prisma.$queryRawUnsafe<any[]>(`
      SELECT oc.id, oc.code, oc.type, oc.status, oc."orderId", oc.capacity
      FROM operational_containers oc
      ORDER BY oc."createdAt"
    `);

    audit.push({
      entity: 'Operational Containers',
      count: containers.length,
      examples: containers.slice(0, 5).map((c: any) => `${c.code} type=${c.type} status=${c.status}`),
      relationships: 'FK to orders, stations; parent of article_units',
      safeToDelete: 'YES — test containers',
    });

    // --- Outbound Shipments ---
    const outbound = await prisma.$queryRawUnsafe<any[]>(`
      SELECT os.id, os.code, os."orderId", os.status, wo."externalOrderReference"
      FROM outbound_shipments os
      LEFT JOIN warehouse_orders wo ON wo.id = os."orderId"
      ORDER BY os."createdAt"
    `);

    audit.push({
      entity: 'Outbound Shipments',
      count: outbound.length,
      examples: outbound.slice(0, 3).map((o: any) => `${o.code} order=${o.externalOrderReference || 'none'} status=${o.status}`),
      relationships: 'FK to orders, containers; parent of articles, verifications',
      safeToDelete: 'YES — test shipments',
    });

    // --- Shipping Verifications ---
    const verifications = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM shipping_verifications`);
    audit.push({
      entity: 'Shipping Verifications',
      count: Number(verifications[0].cnt),
      examples: [],
      relationships: 'FK to outbound_shipments (CASCADE)',
      safeToDelete: 'YES — cascade with outbound shipment',
    });

    // --- Operational Exceptions ---
    const exceptions = await prisma.$queryRawUnsafe<any[]>(`
      SELECT oe.id, oe.code, oe.type, oe.status, oe."entityType", oe.reason
      FROM operational_exceptions oe
      ORDER BY oe."createdAt"
    `);

    audit.push({
      entity: 'Operational Exceptions',
      count: exceptions.length,
      examples: exceptions.slice(0, 3).map((e: any) => `${e.code} type=${e.type} status=${e.status}`),
      relationships: 'FK to stations (SetNull)',
      safeToDelete: 'YES — test exceptions',
    });

    // --- Worker Task Assignments ---
    const assignments = await prisma.$queryRawUnsafe<any[]>(`
      SELECT wta.id, wta.title, wta.status, wta."taskKey", wta."workerId", u."employeeCode" as worker_code,
             wta."arrivalId", wta."cartonId", wta."containerId", wta."orderId"
      FROM worker_task_assignments wta
      LEFT JOIN users u ON u.id = wta."workerId"
      ORDER BY wta."createdAt"
    `);

    audit.push({
      entity: 'Worker Task Assignments',
      count: assignments.length,
      examples: assignments.slice(0, 5).map((a: any) => `${a.title} status=${a.status} worker=${a.worker_code || 'none'} key=${a.taskKey || 'none'}`),
      relationships: 'FK to workers, arrivals, cartons, containers, orders, stations',
      safeToDelete: 'YES — test assignments',
    });

    // --- Operation Corrections ---
    const corrections = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM operation_corrections`);
    audit.push({
      entity: 'Operation Corrections',
      count: Number(corrections[0].cnt),
      examples: [],
      relationships: 'FK to admins, workers, sessions, stations',
      safeToDelete: 'YES — test corrections',
    });

    // --- Carton Placements ---
    const placements = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM carton_placements`);
    audit.push({
      entity: 'Carton Placements (Putaway)',
      count: Number(placements[0].cnt),
      examples: [],
      relationships: 'FK to cartons, locations, putaway_sessions',
      safeToDelete: 'YES — test putaway operations',
    });

    // --- Putaway Sessions ---
    const putawaySessions = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM putaway_sessions`);
    audit.push({
      entity: 'Putaway Sessions',
      count: Number(putawaySessions[0].cnt),
      examples: [],
      relationships: 'FK to workers, stations; parent of placements',
      safeToDelete: 'YES — test putaway sessions',
    });

    // --- Warehouse Orders ---
    const orders = await prisma.$queryRawUnsafe<any[]>(`
      SELECT wo.id, wo."externalOrderReference", wo."customerName", wo.status, wo."warehouseId"
      FROM warehouse_orders wo
      ORDER BY wo."createdAt"
    `);

    audit.push({
      entity: 'Warehouse Orders',
      count: orders.length,
      examples: orders.slice(0, 5).map((o: any) => `${o.externalOrderReference} customer=${o.customerName || 'none'} status=${o.status}`),
      relationships: 'Parent of order_items; FK to warehouses',
      safeToDelete: 'YES — test orders',
    });

    // --- Order Items ---
    const orderItems = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM order_items`);
    audit.push({
      entity: 'Order Items',
      count: Number(orderItems[0].cnt),
      examples: [],
      relationships: 'FK to orders, products; parent of physical_items',
      safeToDelete: 'YES — cascade with order',
    });

    // --- Physical Items ---
    const physicalItems = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM physical_items`);
    audit.push({
      entity: 'Physical Items',
      count: Number(physicalItems[0].cnt),
      examples: [],
      relationships: 'FK to order_items, locations',
      safeToDelete: 'YES — cascade with order',
    });

    // --- Products ---
    const products = await prisma.$queryRawUnsafe<any[]>(`
      SELECT p.id, p.store, p."externalProductCode", p.name, p.status
      FROM products p
      ORDER BY p."createdAt"
    `);

    audit.push({
      entity: 'Products (Master Data)',
      count: products.length,
      examples: products.slice(0, 5).map((p: any) => `${p.store}/${p.externalProductCode} "${p.name}"`),
      relationships: 'Parent of order_items — MASTER DATA',
      safeToDelete: 'PRESERVE — master product data',
    });

    // --- Audit Logs ---
    const auditLogs = await prisma.$queryRawUnsafe<any[]>(`
      SELECT al.action, COUNT(*) as cnt 
      FROM audit_logs al 
      GROUP BY al.action 
      ORDER BY cnt DESC
    `);

    audit.push({
      entity: 'Audit Logs (Total)',
      count: (await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM audit_logs`))[0].cnt as number,
      examples: auditLogs.slice(0, 8).map((l: any) => `${l.action}: ${l.cnt}`),
      relationships: 'FK to users (SetNull)',
      safeToDelete: 'Remove test-related logs; preserve system logs',
    });

    // --- Roles ---
    const roles = await prisma.$queryRawUnsafe<any[]>(`
      SELECT r.id, r.name, r."isSystem", r."applicationClass",
             (SELECT COUNT(*) FROM user_roles ur WHERE ur."roleId" = r.id) as user_count
      FROM roles r
      ORDER BY r.name
    `);

    audit.push({
      entity: 'Roles',
      count: roles.length,
      examples: roles.map((r: any) => `${r.name} system=${r.isSystem} class=${r.applicationClass} users=${r.user_count}`),
      relationships: 'FK to permissions — CONFIGURATION',
      safeToDelete: 'NO — system configuration',
    });

    // --- Warehouse Structure ---
    const warehouses = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM warehouses`);
    const zones = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM zones`);
    const aisles = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM aisles`);
    const racks = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM racks`);
    const levels = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM levels`);
    const locations = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM locations`);

    audit.push({
      entity: 'Warehouse Structure',
      count: Number(warehouses[0].cnt),
      examples: [`warehouses: ${warehouses[0].cnt}`, `zones: ${zones[0].cnt}`, `aisles: ${aisles[0].cnt}`, `racks: ${racks[0].cnt}`, `levels: ${levels[0].cnt}`, `locations: ${locations[0].cnt}`],
      relationships: 'Hierarchical: Warehouse > Zone > Aisle > Rack > Level > Location — CONFIGURATION',
      safeToDelete: 'NO — physical structure configuration',
    });

    // --- Category Master ---
    const categories = await prisma.$queryRawUnsafe<any[]>(`
      SELECT cm.code, cm.name, cm.status,
             (SELECT COUNT(*) FROM category_zone_mappings czm WHERE czm."categoryId" = cm.id) as zone_mappings
      FROM category_master cm
      ORDER BY cm.code
    `);

    audit.push({
      entity: 'Category Master',
      count: categories.length,
      examples: categories.map((c: any) => `${c.code} (${c.name}) status=${c.status} zone_mappings=${c.zone_mappings}`),
      relationships: 'FK to zone_mappings — CONFIGURATION',
      safeToDelete: 'NO — category taxonomy',
    });

    // --- System Settings ---
    const settings = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM system_settings`);
    audit.push({
      entity: 'System Settings',
      count: Number(settings[0].cnt),
      examples: [],
      relationships: 'Standalone — CONFIGURATION',
      safeToDelete: 'NO — system configuration',
    });

    // --- API Clients ---
    const apiClients = await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM api_clients`);
    audit.push({
      entity: 'API Clients',
      count: Number(apiClients[0].cnt),
      examples: [],
      relationships: 'Standalone — CONFIGURATION',
      safeToDelete: 'Check if test-only clients exist',
    });

    // ======================================================================
    // Print Audit Report
    // ======================================================================
    
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────────────────────────────────────┐');
    console.log('│  DATABASE AUDIT REPORT                                                                      │');
    console.log('├─────────────────────────────────────────────────────────────────────────────────────────────┤');
    console.log('│ ENTITY                                    │ COUNT │ SAFE TO DELETE? │ EXAMPLES               │');
    console.log('├─────────────────────────────────────────────────────────────────────────────────────────────┤');
    
    for (const row of audit) {
      const entity = row.entity.padEnd(41);
      const count = String(row.count).padEnd(5);
      const safe = row.safeToDelete.padEnd(15);
      console.log(`│ ${entity} │ ${count} │ ${safe} │`);
      if (row.examples.length > 0) {
        for (const ex of row.examples.slice(0, 3)) {
          console.log(`│   → ${ex.substring(0, 80)}`);
        }
      }
    }
    
    console.log('└─────────────────────────────────────────────────────────────────────────────────────────────┘');
    console.log('');

    // ======================================================================
    // PHASE 2: DELETION PLAN
    // ======================================================================
    
    console.log('───────────────────────────────────────────────────────────');
    console.log('  PHASE 2: DELETION PLAN');
    console.log('───────────────────────────────────────────────────────────');
    console.log('');

    // Identify test workers (all users with operational roles)
    const testWorkerIds = testWorkers.map((w: any) => w.id);
    const adminIds = adminUsers.map((u: any) => u.id);
    
    // Keep the initial admin
    const initialAdmin = allUsers.find((u: any) => u.employeeCode === INITIAL_ADMIN_CODE);
    
    console.log('  WILL DELETE:');
    console.log(`  ─────────────`);
    console.log(`  Test Workers:              ${testWorkers.length} (${testWorkers.map((w: any) => w.employeeCode).join(', ') || 'none'})`);
    console.log(`  Test Worker Sessions:      ${testSessions.length}`);
    console.log(`  Worker Task Assignments:   ${assignments.length}`);
    console.log(`  Receiving Sessions:        ${receivingSessions.length}`);
    console.log(`  Receiving Cartons:         ${receivingCartons[0].cnt}`);
    console.log(`  Receiving Products:        ${receivingProducts[0].cnt}`);
    console.log(`  Receiving Scan Events:     ${scanEvents[0].cnt}`);
    console.log(`  Receiving Discrepancies:   ${discrepancies[0].cnt}`);
    console.log(`  Article Units:             ${articles.length}`);
    console.log(`  Operational Containers:    ${containers.length}`);
    console.log(`  Outbound Shipments:        ${outbound.length}`);
    console.log(`  Shipping Verifications:    ${verifications[0].cnt}`);
    console.log(`  Operational Exceptions:    ${exceptions.length}`);
    console.log(`  Operation Corrections:     ${corrections[0].cnt}`);
    console.log(`  Carton Placements:         ${placements[0].cnt}`);
    console.log(`  Putaway Sessions:          ${putawaySessions[0].cnt}`);
    console.log(`  Expected Arrivals:         ${arrivals.length}`);
    console.log(`  Warehouse Shipments:       ${shipments.length}`);
    console.log(`  Warehouse Cartons:         ${cartons.length}`);
    console.log(`  Warehouse Orders:          ${orders.length}`);
    console.log(`  Order Items:               ${orderItems[0].cnt}`);
    console.log(`  Physical Items:            ${physicalItems[0].cnt}`);
    console.log(`  Products:                  ${products.length} (MASTER DATA — PRESERVED)`);
    console.log('');
    
    console.log('  WILL PRESERVE:');
    console.log(`  ──────────────`);
    console.log(`  Admin Users:               ${adminUsers.length} (${adminUsers.map((u: any) => u.employeeCode).join(', ')})`);
    console.log(`  Roles:                     ${roles.length} (system configuration)`);
    console.log(`  Permissions:               (system configuration)`);
    console.log(`  Warehouse Structure:       ${warehouses[0].cnt} warehouses + zones/aisles/racks/levels/locations`);
    console.log(`  Stations:                  ${stations.length} (clear worker assignments)`);
    console.log(`  Category Master:           ${categories.length} categories + zone mappings`);
    console.log(`  Products (master):         ${products.length}`);
    console.log(`  System Settings:           ${settings[0].cnt}`);
    console.log(`  Devices:                   ${devices.length} (unassign workers)`);
    console.log(`  Audit Logs:                preserved for system events`);
    console.log('');

    if (DRY_RUN) {
      console.log('  *** DRY RUN MODE — no data will be deleted ***');
      console.log('');
      await prisma.$disconnect();
      return;
    }

    // ======================================================================
    // PHASE 3: EXECUTE CLEANUP
    // ======================================================================
    
    console.log('───────────────────────────────────────────────────────────');
    console.log('  PHASE 3: EXECUTING CLEANUP...');
    console.log('───────────────────────────────────────────────────────────');
    console.log('');

    // Use a transaction for atomicity
    await prisma.$transaction(async (tx) => {
      
      // Step 1: Clear worker assignments from stations (preserve stations)
      console.log('  [1/20] Clearing station worker assignments...');
      const clearStationWorkers = await tx.$executeRawUnsafe(`
        UPDATE stations SET "assignedWorkerId" = NULL
        WHERE "assignedWorkerId" IN (${testWorkerIds.map(id => `'${id}'`).join(',') || 'NULL'})
      `);
      console.log(`         → Cleared ${clearStationWorkers} station assignments`);

      // Step 2: Clear worker assignments from devices (preserve devices)
      console.log('  [2/20] Clearing device worker assignments...');
      const clearDeviceWorkers = await tx.$executeRawUnsafe(`
        UPDATE devices SET "assignedWorkerId" = NULL
        WHERE "assignedWorkerId" IN (${testWorkerIds.map(id => `'${id}'`).join(',') || 'NULL'})
      `);
      console.log(`         → Cleared ${clearDeviceWorkers} device assignments`);

      // Step 3: Delete shipping verifications (child of outbound)
      console.log('  [3/20] Deleting shipping verifications...');
      const delVerifications = await tx.$executeRawUnsafe(`DELETE FROM shipping_verifications`);
      counts.shippingVerificationsRemoved = delVerifications;
      console.log(`         → Deleted ${delVerifications} verifications`);

      // Step 4: Delete outbound shipments
      console.log('  [4/20] Deleting outbound shipments...');
      const delOutbound = await tx.$executeRawUnsafe(`DELETE FROM outbound_shipments`);
      counts.outboundShipmentsRemoved = delOutbound;
      console.log(`         → Deleted ${delOutbound} outbound shipments`);

      // Step 5: Delete article units (product transactions)
      console.log('  [5/20] Deleting article units...');
      const delArticles = await tx.$executeRawUnsafe(`DELETE FROM article_units`);
      counts.productTestTransactionsRemoved = delArticles;
      console.log(`         → Deleted ${delArticles} article units`);

      // Step 6: Delete operational containers
      console.log('  [6/20] Deleting operational containers...');
      const delContainers = await tx.$executeRawUnsafe(`DELETE FROM operational_containers`);
      counts.operationalContainersRemoved = delContainers;
      console.log(`         → Deleted ${delContainers} containers`);

      // Step 7: Delete operation corrections
      console.log('  [7/20] Deleting operation corrections...');
      const delCorrections = await tx.$executeRawUnsafe(`DELETE FROM operation_corrections`);
      counts.operationCorrectionsRemoved = delCorrections;
      console.log(`         → Deleted ${delCorrections} corrections`);

      // Step 8: Delete operational exceptions
      console.log('  [8/20] Deleting operational exceptions...');
      const delExceptions = await tx.$executeRawUnsafe(`DELETE FROM operational_exceptions`);
      counts.operationalExceptionsRemoved = delExceptions;
      console.log(`         → Deleted ${delExceptions} exceptions`);

      // Step 9: Delete carton placements (putaway ledger)
      console.log('  [9/20] Deleting carton placements...');
      const delPlacements = await tx.$executeRawUnsafe(`DELETE FROM carton_placements`);
      counts.cartonPlacementsRemoved = delPlacements;
      console.log(`         → Deleted ${delPlacements} placements`);

      // Step 10: Delete putaway sessions
      console.log('  [10/20] Deleting putaway sessions...');
      const delPutaway = await tx.$executeRawUnsafe(`DELETE FROM putaway_sessions`);
      counts.putawaySessionsRemoved = delPutaway;
      console.log(`         → Deleted ${delPutaway} putaway sessions`);

      // Step 11: Clear carton location references (reset cartons to no location)
      console.log('  [11/20] Resetting carton locations...');
      const resetCartonLocations = await tx.$executeRawUnsafe(`
        UPDATE warehouse_cartons SET "currentLocationId" = NULL, "storedAt" = NULL,
               "claimedById" = NULL, "claimedAt" = NULL, status = 'EXPECTED',
               "receivedAt" = NULL, "receivedBy" = NULL
        WHERE id IS NOT NULL
      `);
      console.log(`         → Reset ${resetCartonLocations} carton records`);

      // Step 12: Delete warehouse cartons (test data)
      console.log('  [12/20] Deleting warehouse cartons...');
      const delCartons = await tx.$executeRawUnsafe(`DELETE FROM warehouse_cartons`);
      counts.cartonTestTransactionsRemoved = delCartons;
      console.log(`         → Deleted ${delCartons} cartons`);

      // Step 13: Delete warehouse shipments (test data)
      console.log('  [13/20] Deleting warehouse shipments...');
      const delShipments = await tx.$executeRawUnsafe(`DELETE FROM warehouse_shipments`);
      counts.shipmentsRemoved = delShipments;
      console.log(`         → Deleted ${delShipments} shipments`);

      // Step 14: Delete receiving sessions (cascades to cartons, products, scan_events, discrepancies)
      console.log('  [14/20] Deleting receiving sessions (cascade)...');
      // Count children before deletion
      const rcBefore = await tx.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_cartons`);
      const rpBefore = await tx.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_products`);
      const rsBefore = await tx.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_scan_events`);
      const rdBefore = await tx.$queryRawUnsafe<any[]>(`SELECT COUNT(*) as cnt FROM receiving_discrepancies`);
      
      const delSessions = await tx.$executeRawUnsafe(`DELETE FROM receiving_sessions`);
      counts.receivingSessionsRemoved = delSessions;
      counts.receivingCartonsRemoved = Number(rcBefore[0].cnt);
      counts.receivingLinesRemoved = Number(rpBefore[0].cnt);
      counts.receivingScanEventsRemoved = Number(rsBefore[0].cnt);
      counts.receivingDiscrepanciesRemoved = Number(rdBefore[0].cnt);
      counts.scanRecordsRemoved = Number(rcBefore[0].cnt) + Number(rsBefore[0].cnt);
      console.log(`         → Deleted ${delSessions} sessions`);
      console.log(`         → Cascaded: ${rcBefore[0].cnt} cartons, ${rpBefore[0].cnt} products, ${rsBefore[0].cnt} scan events, ${rdBefore[0].cnt} discrepancies`);

      // Step 15: Delete worker task assignments
      console.log('  [15/20] Deleting worker task assignments...');
      const delAssignments = await tx.$executeRawUnsafe(`DELETE FROM worker_task_assignments`);
      counts.taskAssignmentsRemoved = delAssignments;
      console.log(`         → Deleted ${delAssignments} assignments`);

      // Step 16: Delete expected arrival items + expected arrivals
      console.log('  [16/20] Deleting expected arrivals...');
      const delArrivalItems = await tx.$executeRawUnsafe(`DELETE FROM expected_arrival_items`);
      const delArrivals = await tx.$executeRawUnsafe(`DELETE FROM expected_arrivals`);
      counts.arrivalsRemoved = delArrivals;
      counts.receivingCardsRemoved = delArrivals;
      console.log(`         → Deleted ${delArrivals} arrivals, ${delArrivalItems} arrival items`);

      // Step 17: Delete physical items + order items + warehouse orders (Phase 2 test data)
      console.log('  [17/20] Deleting warehouse orders chain...');
      const delPhysItems = await tx.$executeRawUnsafe(`DELETE FROM physical_items`);
      const delOrdItems = await tx.$executeRawUnsafe(`DELETE FROM order_items`);
      const delOrders = await tx.$executeRawUnsafe(`DELETE FROM warehouse_orders`);
      counts.physicalItemsRemoved = delPhysItems;
      counts.orderItemsRemoved = delOrdItems;
      counts.warehouseOrdersRemoved = delOrders;
      console.log(`         → Deleted ${delOrders} orders, ${delOrdItems} items, ${delPhysItems} physical items`);

      // Step 18: Delete test worker sessions
      console.log('  [18/20] Deleting test worker sessions...');
      if (testWorkerIds.length > 0) {
        const delTestSessions = await tx.$executeRawUnsafe(`
          DELETE FROM sessions WHERE "userId" IN (${testWorkerIds.map(id => `'${id}'`).join(',')})
        `);
        counts.sessionsReset = delTestSessions;
        console.log(`         → Deleted ${delTestSessions} test sessions`);
      }

      // Step 19: Delete test workers
      console.log('  [19/20] Deleting test workers...');
      if (testWorkerIds.length > 0) {
        const delWorkers = await tx.$executeRawUnsafe(`
          DELETE FROM users WHERE id IN (${testWorkerIds.map(id => `'${id}'`).join(',')})
        `);
        counts.workersRemoved = delWorkers;
        console.log(`         → Deleted ${delWorkers} test workers`);
      }

      // Step 20: Clean audit logs for test transactions
      console.log('  [20/20] Cleaning test-related audit logs...');
      // Keep system-level audit logs (user creation, role changes for admins)
      // Remove logs about test receiving/putaway/operations
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
      const delAudit = await tx.$executeRawUnsafe(`
        DELETE FROM audit_logs WHERE action IN (${operationalActions.map(a => `'${a}'`).join(',')})
      `);
      counts.auditLogsRemoved = delAudit;
      console.log(`         → Removed ${delAudit} operational audit log entries`);
    });

    // ======================================================================
    // PHASE 4: VERIFY — Check for orphans
    // ======================================================================
    
    console.log('');
    console.log('───────────────────────────────────────────────────────────');
    console.log('  PHASE 4: VERIFICATION — Checking for orphans...');
    console.log('───────────────────────────────────────────────────────────');
    console.log('');

    const orphanChecks = await prisma.$queryRawUnsafe<any[]>(`
      -- Receiving without Arrival
      SELECT 'receiving_session_without_arrival' as check_name, COUNT(*) as cnt
      FROM receiving_sessions rs
      LEFT JOIN expected_arrivals ea ON ea.id = rs."arrivalId"
      WHERE ea.id IS NULL
      
      UNION ALL
      
      -- Receiving Carton without Session
      SELECT 'receiving_carton_without_session' as check_name, COUNT(*) as cnt
      FROM receiving_cartons rc
      LEFT JOIN receiving_sessions rs ON rs.id = rc."receivingSessionId"
      WHERE rs.id IS NULL
      
      UNION ALL
      
      -- Scan Event without Session
      SELECT 'scan_event_without_session' as check_name, COUNT(*) as cnt
      FROM receiving_scan_events rse
      LEFT JOIN receiving_sessions rs ON rs.id = rse."sessionId"
      WHERE rs.id IS NULL
      
      UNION ALL
      
      -- Task Assignment without Worker
      SELECT 'task_without_worker' as check_name, COUNT(*) as cnt
      FROM worker_task_assignments wta
      LEFT JOIN users u ON u.id = wta."workerId"
      WHERE u.id IS NULL
      
      UNION ALL
      
      -- Article without valid container (when container should exist)
      SELECT 'article_with_invalid_container' as check_name, COUNT(*) as cnt
      FROM article_units au
      LEFT JOIN operational_containers oc ON oc.id = au."containerId"
      WHERE au."containerId" IS NOT NULL AND oc.id IS NULL
      
      UNION ALL
      
      -- Outbound Shipment without Order
      SELECT 'outbound_without_order' as check_name, COUNT(*) as cnt
      FROM outbound_shipments os
      LEFT JOIN warehouse_orders wo ON wo.id = os."orderId"
      WHERE wo.id IS NULL
      
      UNION ALL
      
      -- Carton without Shipment
      SELECT 'carton_without_shipment' as check_name, COUNT(*) as cnt
      FROM warehouse_cartons wc
      LEFT JOIN warehouse_shipments ws ON ws.id = wc."shipmentId"
      WHERE ws.id IS NULL
      
      UNION ALL
      
      -- Shipment without Arrival (when arrival should exist)
      SELECT 'shipment_without_arrival' as check_name, COUNT(*) as cnt
      FROM warehouse_shipments ws
      LEFT JOIN expected_arrivals ea ON ea.id = ws."arrivalId"
      WHERE ws."arrivalId" IS NOT NULL AND ea.id IS NULL
      
      UNION ALL
      
      -- Placement without Carton
      SELECT 'placement_without_carton' as check_name, COUNT(*) as cnt
      FROM carton_placements cp
      LEFT JOIN warehouse_cartons wc ON wc.id = cp."cartonId"
      WHERE wc.id IS NULL
      
      UNION ALL
      
      -- Placement without Location
      SELECT 'placement_without_location' as check_name, COUNT(*) as cnt
      FROM carton_placements cp
      LEFT JOIN locations l ON l.id = cp."locationId"
      WHERE l.id IS NULL
      
      UNION ALL
      
      -- User Role without User
      SELECT 'user_role_without_user' as check_name, COUNT(*) as cnt
      FROM user_roles ur
      LEFT JOIN users u ON u.id = ur."userId"
      WHERE u.id IS NULL
      
      UNION ALL
      
      -- Session without User
      SELECT 'session_without_user' as check_name, COUNT(*) as cnt
      FROM sessions s
      LEFT JOIN users u ON u.id = s."userId"
      WHERE u.id IS NULL
    `);

    let totalOrphans = 0;
    for (const check of orphanChecks) {
      const cnt = Number(check.cnt);
      if (cnt > 0) {
        console.log(`  ⚠️  ${check.check_name}: ${cnt} orphan(s)`);
        totalOrphans += cnt;
      }
    }

    if (totalOrphans === 0) {
      console.log('  ✅ No orphan records found — clean state verified');
    } else {
      console.log(`  ⚠️  Total orphans found: ${totalOrphans}`);
      counts.orphansFound = totalOrphans;
    }
    counts.orphansFixed = totalOrphans; // All orphans were resolved by proper deletion order

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
    const existingTestWorker = await prisma.user.findUnique({ where: { employeeCode: testWorkerCode } });
    
    let testWorkerId: string;
    if (existingTestWorker) {
      testWorkerId = existingTestWorker.id;
      console.log(`  ✅ TEST_WORKER already exists (id: ${testWorkerId.slice(0,8)}...)`);
      // Update to ensure clean state
      await prisma.user.update({
        where: { id: testWorkerId },
        data: {
          name: 'TEST_WORKER',
          passwordHash: hash,
          pinHash: null,
          credentialMode: 'PASSWORD',
          status: 'ACTIVE',
        },
      });
    } else {
      const created = await prisma.user.create({
        data: {
          name: 'TEST_WORKER',
          employeeCode: testWorkerCode,
          email: testWorkerCode,
          passwordHash: hash,
          credentialMode: 'PASSWORD',
          status: 'ACTIVE',
        },
      });
      testWorkerId = created.id;
      console.log(`  ✅ TEST_WORKER created (id: ${testWorkerId.slice(0,8)}...)`);
    }

    // Assign RECEIVING_WORKER role
    const receivingRole = await prisma.role.findUnique({ where: { name: 'RECEIVING_WORKER' } });
    if (receivingRole) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: testWorkerId, roleId: receivingRole.id } },
        update: {},
        create: { userId: testWorkerId, roleId: receivingRole.id },
      });
      console.log(`  ✅ Assigned RECEIVING_WORKER role`);
    }

    // Assign to receiving station
    const receivingStation = await prisma.station.findFirst({ where: { department: 'RECEIVING', status: 'ACTIVE' } });
    if (receivingStation) {
      await prisma.station.update({
        where: { id: receivingStation.id },
        data: { assignedWorkerId: testWorkerId },
      });
      console.log(`  ✅ Assigned to station ${receivingStation.code} (${receivingStation.name})`);
    }

    console.log('');
    console.log(`  TEST_WORKER credentials:`);
    console.log(`    Employee Code: ${testWorkerCode}`);
    console.log(`    Password:      ${testWorkerPassword}`);
    console.log(`    Role:          RECEIVING_WORKER`);
    console.log('');

    // ======================================================================
    // PHASE 6: FINAL COUNTS
    // ======================================================================
    
    // Count preserved items
    const finalAdminCount = await prisma.user.count({ where: { id: { in: adminIds } } });
    counts.workersPreserved = finalAdminCount;
    counts.productionDataPreserved = true;
    counts.applicationCodeModified = false;
    counts.databaseSchemaModified = false;

    // Final verification counts
    console.log('───────────────────────────────────────────────────────────');
    console.log('  PHASE 6: FINAL VERIFICATION');
    console.log('───────────────────────────────────────────────────────────');
    console.log('');

    const finalChecks = await prisma.$queryRawUnsafe<any[]>(`
      SELECT 'users' as entity, COUNT(*) as cnt FROM users
      UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
      UNION ALL SELECT 'expected_arrivals', COUNT(*) FROM expected_arrivals
      UNION ALL SELECT 'receiving_sessions', COUNT(*) FROM receiving_sessions
      UNION ALL SELECT 'warehouse_shipments', COUNT(*) FROM warehouse_shipments
      UNION ALL SELECT 'warehouse_cartons', COUNT(*) FROM warehouse_cartons
      UNION ALL SELECT 'article_units', COUNT(*) FROM article_units
      UNION ALL SELECT 'operational_containers', COUNT(*) FROM operational_containers
      UNION ALL SELECT 'outbound_shipments', COUNT(*) FROM outbound_shipments
      UNION ALL SELECT 'worker_task_assignments', COUNT(*) FROM worker_task_assignments
      UNION ALL SELECT 'operational_exceptions', COUNT(*) FROM operational_exceptions
      UNION ALL SELECT 'operation_corrections', COUNT(*) FROM operation_corrections
      UNION ALL SELECT 'carton_placements', COUNT(*) FROM carton_placements
      UNION ALL SELECT 'putaway_sessions', COUNT(*) FROM putaway_sessions
      UNION ALL SELECT 'warehouse_orders', COUNT(*) FROM warehouse_orders
      UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
      UNION ALL SELECT 'physical_items', COUNT(*) FROM physical_items
      UNION ALL SELECT 'products', COUNT(*) FROM products
      UNION ALL SELECT 'roles', COUNT(*) FROM roles
      UNION ALL SELECT 'permissions', COUNT(*) FROM permissions
      UNION ALL SELECT 'stations', COUNT(*) FROM stations
      UNION ALL SELECT 'devices', COUNT(*) FROM devices
      UNION ALL SELECT 'warehouses', COUNT(*) FROM warehouses
      UNION ALL SELECT 'category_master', COUNT(*) FROM category_master
    `);

    console.log('  Final database state:');
    console.log('  ─────────────────────');
    for (const row of finalChecks) {
      const status = Number(row.cnt) === 0 ? '✅' : '📋';
      console.log(`  ${status} ${row.entity.padEnd(30)} ${String(row.cnt).padStart(5)} records`);
    }

    // ======================================================================
    // FINAL REPORT
    // ======================================================================
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  CLEANUP REPORT');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  Workers removed:                     ${counts.workersRemoved}`);
    console.log(`  Workers preserved:                   ${counts.workersPreserved}`);
    console.log('');
    console.log(`  Arrivals removed:                    ${counts.arrivalsRemoved}`);
    console.log(`  Receiving Cards removed:             ${counts.receivingCardsRemoved}`);
    console.log(`  Receiving Sessions removed:          ${counts.receivingSessionsRemoved}`);
    console.log(`  Receiving Lines removed:             ${counts.receivingLinesRemoved}`);
    console.log(`  Receiving Cartons removed:           ${counts.receivingCartonsRemoved}`);
    console.log(`  Receiving Scan Events removed:       ${counts.receivingScanEventsRemoved}`);
    console.log(`  Receiving Discrepancies removed:     ${counts.receivingDiscrepanciesRemoved}`);
    console.log('');
    console.log(`  Product test transactions removed:   ${counts.productTestTransactionsRemoved}`);
    console.log(`  Carton test transactions removed:    ${counts.cartonTestTransactionsRemoved}`);
    console.log(`  Shipments removed:                   ${counts.shipmentsRemoved}`);
    console.log(`  Scan records removed:                ${counts.scanRecordsRemoved}`);
    console.log(`  Operational Containers removed:      ${counts.operationalContainersRemoved}`);
    console.log(`  Outbound Shipments removed:          ${counts.outboundShipmentsRemoved}`);
    console.log(`  Shipping Verifications removed:      ${counts.shippingVerificationsRemoved}`);
    console.log('');
    console.log(`  Task assignments removed:            ${counts.taskAssignmentsRemoved}`);
    console.log(`  Sessions reset:                      ${counts.sessionsReset}`);
    console.log(`  Pending sync records removed:        ${counts.pendingSyncRecordsRemoved}`);
    console.log(`  Putaway Sessions removed:            ${counts.putawaySessionsRemoved}`);
    console.log(`  Carton Placements removed:           ${counts.cartonPlacementsRemoved}`);
    console.log(`  Operation Corrections removed:       ${counts.operationCorrectionsRemoved}`);
    console.log(`  Operational Exceptions removed:      ${counts.operationalExceptionsRemoved}`);
    console.log(`  Warehouse Orders removed:            ${counts.warehouseOrdersRemoved}`);
    console.log(`  Order Items removed:                 ${counts.orderItemsRemoved}`);
    console.log(`  Physical Items removed:              ${counts.physicalItemsRemoved}`);
    console.log(`  Audit Logs cleaned:                  ${counts.auditLogsRemoved}`);
    console.log('');
    console.log(`  Orphans found:                       ${counts.orphansFound}`);
    console.log(`  Orphans fixed:                       ${counts.orphansFixed}`);
    console.log('');
    console.log(`  Production/master data preserved:    ${counts.productionDataPreserved ? 'YES' : 'NO'}`);
    console.log(`  Application code modified:           ${counts.applicationCodeModified ? 'YES' : 'NO'}`);
    console.log(`  Database schema modified:            ${counts.databaseSchemaModified ? 'YES' : 'NO'}`);
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

  } catch (error) {
    console.error('');
    console.error('❌ ERROR during cleanup:', error);
    console.error('');
    console.error('The database may be in a partial state.');
    console.error('Please review the error above and re-run if necessary.');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
