/**
 * AYROVI Warehouse Core — Phase 0 seed.
 *
 * Idempotent: safe to run multiple times (upserts).
 *
 * Creates:
 *   - The full, granular Permission catalog (Phase 0 scope only).
 *   - The seeded Roles (SUPER_ADMIN, WAREHOUSE_ADMIN, ...).
 *   - An initial SUPER_ADMIN user from the environment, if provided.
 *
 * Usage:
 *   DATABASE_URL=... npm run db:seed
 */

// Load environment variables from .env (and the repo root fallback) so
// `npm run db:seed` works without exporting DATABASE_URL manually.
// PrismaClient does NOT auto-load .env at runtime (only the Prisma CLI does).
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config(); // ./backend/.env
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') }); // repo root .env

import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { seedPolicy } from '../src/modules/system/seed-policy';

const prisma = new PrismaClient();

// ---------------------------------------------------------------
// Permission catalog (Phase 0)
// The `execute` permissions for receiving/stowing/picking/packing/
// shipping are defined HERE so the architecture is ready, but Phase 0
// does NOT implement the underlying workflows.
// ---------------------------------------------------------------
// ------------------------------------------------------------------
// Phase 1 — granular physical-structure permissions.
// Replaces the Phase-0 coarse keys (warehouse.view/manage, locations.*).
// D-32: legacy keys are MIGRATED below (idempotently) into the granular set.
// ------------------------------------------------------------------
const STRUCTURE_RESOURCES = ['warehouses', 'zones', 'aisles', 'racks', 'levels', 'locations'];
const STRUCTURE_ACTIONS = ['view', 'create', 'update', 'activate', 'deactivate'];

const STRUCTURE_PERMISSIONS: Array<{ key: string; resource: string; action: string; description: string }> =
  STRUCTURE_RESOURCES.flatMap((res) =>
    STRUCTURE_ACTIONS.map((action) => ({
      key: `${res}.${action}`,
      resource: res,
      action,
      description: `${action[0].toUpperCase() + action.slice(1)} ${res.replace(/s$/, '')} in the physical structure`,
    })),
  );

const PERMISSIONS: Array<{ key: string; resource: string; action: string; description: string }> = [
  // ---- Phase 1: physical warehouse structure (granular) ----
  ...STRUCTURE_PERMISSIONS,

  // ---- Phase 2: product & order item identity (granular, design §13/§14) ----
  { key: 'products.view', resource: 'products', action: 'view', description: 'View products' },
  { key: 'products.create', resource: 'products', action: 'create', description: 'Create products' },
  { key: 'products.update', resource: 'products', action: 'update', description: 'Update products (identity fields immutable — D-55)' },
  { key: 'products.activate', resource: 'products', action: 'activate', description: 'Activate products' },
  { key: 'products.deactivate', resource: 'products', action: 'deactivate', description: 'Deactivate products (no delete — D-35)' },
  { key: 'warehouse_orders.view', resource: 'warehouse_orders', action: 'view', description: 'View warehouse orders' },
  { key: 'warehouse_orders.create', resource: 'warehouse_orders', action: 'create', description: 'Create warehouse orders (idempotent — D-56B/D-65)' },
  { key: 'warehouse_orders.update', resource: 'warehouse_orders', action: 'update', description: 'Update warehouse orders' },
  { key: 'warehouse_orders.cancel', resource: 'warehouse_orders', action: 'cancel', description: 'Cancel warehouse orders (local — no cascade until Cascade-A is decided)' },
  { key: 'order_items.view', resource: 'order_items', action: 'view', description: 'View order items' },
  { key: 'order_items.create', resource: 'order_items', action: 'create', description: 'Create order items' },
  { key: 'order_items.update', resource: 'order_items', action: 'update', description: 'Update order items (D-57 strict cap applies to piece count)' },
  { key: 'order_items.cancel', resource: 'order_items', action: 'cancel', description: 'Cancel order items' },
  { key: 'physical_items.view', resource: 'physical_items', action: 'view', description: 'View physical items' },
  { key: 'physical_items.create', resource: 'physical_items', action: 'create', description: 'Create physical items (EXPECTED — D-45; strict cap D-57)' },
  { key: 'physical_items.cancel', resource: 'physical_items', action: 'cancel', description: 'Cancel physical items (from EXPECTED only)' },
  // NOTE: physical_items.update intentionally does NOT exist in Phase 2 (design §13).

  // ---- Phase 0 (unchanged) ----
  // Inventory (permission ready; workflow deferred)
  { key: 'inventory.view', resource: 'inventory', action: 'view', description: 'View inventory' },
  { key: 'inventory.manage', resource: 'inventory', action: 'manage', description: 'Manage inventory' },

  // Inbound (permission ready; workflow deferred)
  { key: 'receiving.view', resource: 'receiving', action: 'view', description: 'View receiving operations' },
  { key: 'receiving.execute', resource: 'receiving', action: 'execute', description: 'Execute receiving operations' },

  // Expected Arrivals — inbound Customer Arrival Cards pushed by Arrival CRM.
  // Only a view permission exists: creating expected arrivals is done by the
  // service-authenticated integration endpoint, not by a logged-in user, and
  // physical receiving is a later phase.
  { key: 'expected_arrivals.view', resource: 'expected_arrivals', action: 'view', description: 'View expected arrivals (Customer Arrival Cards received via API)' },

  { key: 'shipments.view', resource: 'shipments', action: 'view', description: 'View inbound shipments & cartons (Shipment Cards received via API)' },

  { key: 'receiving.view', resource: 'receiving', action: 'view', description: 'View receiving sessions and progress' },
  { key: 'receiving.execute', resource: 'receiving', action: 'execute', description: 'Start/receive/pause receiving: scan cartons and record product receipts' },
  { key: 'receiving.resolve_discrepancy', resource: 'receiving', action: 'resolve', description: 'Resolve discrepancies and close receiving with a discrepancy (supervisor)' },

  { key: 'stowing.view', resource: 'stowing', action: 'view', description: 'View stowing operations' },
  { key: 'stowing.execute', resource: 'stowing', action: 'execute', description: 'Execute stowing operations' },

  // Outbound (permission ready; workflow deferred)
  { key: 'picking.view', resource: 'picking', action: 'view', description: 'View picking operations' },
  { key: 'picking.execute', resource: 'picking', action: 'execute', description: 'Execute picking operations' },

  { key: 'packing.view', resource: 'packing', action: 'view', description: 'View packing operations' },
  { key: 'packing.execute', resource: 'packing', action: 'execute', description: 'Execute packing operations' },

  { key: 'shipping.view', resource: 'shipping', action: 'view', description: 'View shipping operations' },
  { key: 'shipping.execute', resource: 'shipping', action: 'execute', description: 'Execute shipping operations' },

  // ---- AYROVI Batch (Phase 2 contract; workflows land behind batch.enabled) ----
  { key: 'batch.view', resource: 'batch', action: 'view', description: 'View batch cards and batch details' },
  { key: 'batch.create', resource: 'batch', action: 'create', description: 'Create a batch (France worker app)' },
  { key: 'batch.execute', resource: 'batch', action: 'execute', description: 'Register units into a batch (scan/print labels)' },
  { key: 'batch.accept', resource: 'batch', action: 'accept', description: 'Admin: accept a submitted batch card' },
  { key: 'batch.send', resource: 'batch', action: 'send', description: 'Admin: send an accepted batch to Receiving' },
  { key: 'batch.receive', resource: 'batch', action: 'receive', description: 'Tunisia: receive a batch (own the batch session)' },
  { key: 'batch.void', resource: 'batch', action: 'void', description: 'Admin: void a batch (audit-safe, no delete)' },

  // Administration
  { key: 'users.view', resource: 'users', action: 'view', description: 'View users' },
  { key: 'users.manage', resource: 'users', action: 'manage', description: 'Create, update and disable users' },

  { key: 'roles.view', resource: 'roles', action: 'view', description: 'View roles' },
  { key: 'roles.manage', resource: 'roles', action: 'manage', description: 'Create and manage roles and role permissions' },

  // WAREHOUSE OS — Admin Control Center. Deliberately NOT granted to floor
  // worker roles: the operational overview aggregates every worker, station
  // and session, which is supervisory information (§46).
  { key: 'operations.view', resource: 'operations', action: 'view', description: 'View the Admin Control Center operational overview, workers, sessions and exceptions' },
  { key: 'operations.correct', resource: 'operations', action: 'correct', description: 'Apply audited corrections to recorded operations' },
  { key: 'stations.view', resource: 'stations', action: 'view', description: 'View stations' },
  { key: 'stations.manage', resource: 'stations', action: 'manage', description: 'Create, update, assign and change status of stations' },
  { key: 'audit.view', resource: 'audit', action: 'view', description: 'View audit log' },

  // System (documented addition for Phase 0 Core)
  { key: 'system.view', resource: 'system', action: 'view', description: 'View system settings and API clients' },
  { key: 'system.manage', resource: 'system', action: 'manage', description: 'Manage system settings and API clients' },
  { key: 'api_clients.view', resource: 'api_clients', action: 'view', description: 'View API clients' },
  { key: 'api_clients.manage', resource: 'api_clients', action: 'manage', description: 'Manage API clients' },
];

const ALL = PERMISSIONS.map((p) => p.key);
const VIEW_KEYS = (res: string) => PERMISSIONS.filter((p) => p.resource === res && p.action === 'view').map((p) => p.key);
const MANAGE_KEYS = (res: string) => PERMISSIONS.filter((p) => p.resource === res && p.action === 'manage').map((p) => p.key);
const EXECUTE_KEYS = (res: string) => PERMISSIONS.filter((p) => p.resource === res && p.action === 'execute').map((p) => p.key);

// ---- Phase 2 (design §14): identity resources role mapping ----
const PHASE2_VIEW = ['products', 'warehouse_orders', 'order_items', 'physical_items'].flatMap((r) => VIEW_KEYS(r));
const PHASE2_WRITE = [
  'products.create', 'products.update', 'products.activate', 'products.deactivate',
  'warehouse_orders.create', 'warehouse_orders.update', 'warehouse_orders.cancel',
  'order_items.create', 'order_items.update', 'order_items.cancel',
  'physical_items.create', 'physical_items.cancel',
];
// D-34 precedent: WAREHOUSE_MANAGER gets update/cancel, NOT create.
const PHASE2_MANAGER_WRITE = [
  'products.update', 'products.activate', 'products.deactivate',
  'warehouse_orders.update', 'warehouse_orders.cancel',
  'order_items.update', 'order_items.cancel',
  'physical_items.cancel',
];

// Fine-grained structure helpers.
const STRUCT_ACTIONS = ['view', 'create', 'update', 'activate', 'deactivate'];
const STRUCT_KEYS = (res: string, actions: string[]) =>
  PERMISSIONS.filter((p) => p.resource === res && actions.includes(p.action)).map((p) => p.key);
const STRUCT_VIEW = (res: string) => STRUCT_KEYS(res, ['view']);
const STRUCT_WRITE = (res: string) => STRUCT_KEYS(res, ['create', 'update', 'activate', 'deactivate']);
const STRUCT_FULL = (res: string) => STRUCT_KEYS(res, STRUCT_ACTIONS);
const ALL_STRUCT_VIEW = STRUCTURE_RESOURCES.flatMap((r) => STRUCT_VIEW(r));
const ALL_STRUCT_WRITE = STRUCTURE_RESOURCES.flatMap((r) => STRUCT_WRITE(r));
const ALL_STRUCT_FULL = STRUCTURE_RESOURCES.flatMap((r) => STRUCT_FULL(r));

const ROLES: Array<{
  name: string;
  description: string;
  isSystem: boolean;
  applicationClass: 'ADMIN' | 'OPERATIONAL' | 'VIEWER' | 'UNKNOWN';
  permissions: string[];
}> = [
  {
    name: 'SUPER_ADMIN',
    description: 'Full, unrestricted access to the whole system.',
    isSystem: true,
    applicationClass: 'ADMIN',
    permissions: ALL,
  },
  {
    name: 'WAREHOUSE_ADMIN',
    description: 'Operational administration of the warehouse (full physical structure management).',
    isSystem: true,
    applicationClass: 'ADMIN',
    permissions: [
      // Full physical-structure management (D-34: this role may create).
      ...ALL_STRUCT_FULL,
      ...ALL.filter((k) => k.startsWith('inventory.')),
      // Phase 2 identity resources (§14): full management.
      ...PHASE2_VIEW, ...PHASE2_WRITE,
      ...MANAGE_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      ...MANAGE_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
      ...MANAGE_KEYS('picking'), ...EXECUTE_KEYS('picking'),
      ...MANAGE_KEYS('packing'), ...EXECUTE_KEYS('packing'),
      ...MANAGE_KEYS('shipping'), ...EXECUTE_KEYS('shipping'),
      'users.view', 'users.manage', 'roles.view', 'roles.manage', 'audit.view',
      'system.view', 'system.manage', 'api_clients.view', 'api_clients.manage',
      'expected_arrivals.view', 'shipments.view', 'receiving.resolve_discrepancy',
      // Admin Control Center (§6/§36).
      'operations.view', 'operations.correct', 'stations.view', 'stations.manage',
    ],
  },
  {
    name: 'WAREHOUSE_MANAGER',
    description: 'Day-to-day warehouse management without full system admin.',
    isSystem: true,
    applicationClass: 'ADMIN',
    permissions: [
      // D-34: view + update + activate + deactivate on all structure nodes.
      // NO create permission.
      ...STRUCTURE_RESOURCES.flatMap((r) => STRUCT_KEYS(r, ['view', 'update', 'activate', 'deactivate'])),
      ...VIEW_KEYS('inventory'), ...MANAGE_KEYS('inventory'),
      // Phase 2 (§14): view + update/cancel, NO create (D-34 precedent).
      ...PHASE2_VIEW, ...PHASE2_MANAGER_WRITE,
      ...VIEW_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      ...VIEW_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
      ...VIEW_KEYS('picking'), ...EXECUTE_KEYS('picking'),
      ...VIEW_KEYS('packing'), ...EXECUTE_KEYS('packing'),
      ...VIEW_KEYS('shipping'), ...EXECUTE_KEYS('shipping'),
      'users.view', 'roles.view', 'audit.view', 'system.view', 'api_clients.view',
      'expected_arrivals.view', 'shipments.view', 'receiving.resolve_discrepancy',
      // Supervises the floor and may correct, but does not configure stations.
      'operations.view', 'operations.correct', 'stations.view',
      // Phase 2 BATCH: the manager takes the batch lifecycle decisions.
      'batch.view', 'batch.accept', 'batch.send', 'batch.void',
    ],
  },
  {
    name: 'INBOUND_WORKER',
    // COMPATIBILITY ROLE (worker operational model §3): superseded by the
    // granular RECEIVING_WORKER / PUTAWAY_WORKER / SORTING_WORKER roles.
    // Kept — never renamed or deleted without migration analysis — so
    // existing users keep their access; new workers should get the granular
    // roles. Permission set intentionally matches RECEIVING + PUTAWAY +
    // SORTING so behavior is unchanged for legacy accounts.
    description: 'COMPATIBILITY: legacy inbound worker (receiving/sorting/putaway). Prefer RECEIVING_WORKER / SORTING_WORKER / PUTAWAY_WORKER.',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW, // Phase 1: view locations only in the structure.
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW, // Phase 2: view-only — no mutations until receiving exists (§14).
      ...VIEW_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      ...VIEW_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
      'expected_arrivals.view', 'shipments.view',
      // Deliberately NO operations.* here: the floor worker must never see the
      // Admin Control Center aggregate views (§2/§46). Station visibility is
      // limited to their own, served by /terminal/context.
      'stations.view',
    ],
  },
  // ---- Worker operational model (§3/§4): granular floor roles ------------
  // One role per operational department; multi-role assignment is allowed.
  // None of them carry operations.view (§4) — admin oversight stays admin.
  {
    name: 'BATCH_WORKER',
    // Phase 2 BATCH (user order 2026-09-12): the floor agent of the batch
    // operation at BATCH-01 — builds batches (customer in-app, AYP per
    // unit, label printing) and receives the batches the admin sent.
    description: 'Batch agent: build batches (customer + AYP units + labels) and receive sent batches (10/10). Tasks: batch, batch-in.',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      // v72 (owner order): the batch lane is BATCH-ONLY — no receiving perms,
      // so the worker HOME renders exactly BATCH + BATCH IN (no RECEIVING).
      'expected_arrivals.view', 'shipments.view',
      'batch.view', 'batch.execute', 'batch.receive',
    ],
  },
  {
    name: 'RECEIVING_WORKER',
    description: 'Receiving dock worker: verify cartons and products against expected arrivals (task: receiving).',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      ...VIEW_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      'expected_arrivals.view', 'shipments.view',
    ],
  },
  {
    name: 'TEMP_STORAGE_WORKER',
    // Reference workflow: the "Agent de stockage temporaire" is the worker
    // bound to the Temporary Storage station (ST-STG-01, department STAGING).
    // Same operational vocabulary as RECEIVING_WORKER — the STATION binding
    // and the STAGING department gate are what select this operation.
    description: 'Temporary Storage agent: place CONFIRMED products into temporary containers by customer section (task: temporary-storage).',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      ...VIEW_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      'expected_arrivals.view', 'shipments.view',
    ],
  },
  {
    name: 'SORTING_WORKER',
    // Reference workflow: the "Agent de tri" performs TRI PAR CLIENT — he takes
    // the products stored by the Temporary Storage agent and puts each one in
    // its CUSTOMER container. That is the order-sorting (picking) lane, so the
    // role carries the picking permissions in addition to stowing.
    description: 'Sorting worker: tri par client — sort products into customer containers (tasks: order-sorting, sorting).',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      ...VIEW_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
      ...VIEW_KEYS('picking'), ...EXECUTE_KEYS('picking'),
    ],
  },
  {
    name: 'PUTAWAY_WORKER',
    description: 'Putaway worker: stow received cartons onto storage locations (task: putaway).',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      ...VIEW_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
    ],
  },
  {
    name: 'PACKING_WORKER',
    description: 'Packing bench worker: pack customer bins into outbound shipments (task: packing).',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      ...VIEW_KEYS('packing'), ...EXECUTE_KEYS('packing'),
    ],
  },
  {
    name: 'SHIPPING_WORKER',
    description: 'Dispatch worker: scan outbound shipments and dispatch them (task: shipping). Fixes C-5.',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW,
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW,
      ...VIEW_KEYS('shipping'), ...EXECUTE_KEYS('shipping'),
    ],
  },
  {
    name: 'PICKER',
    description: 'Warehouse picker.',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW, // Phase 1: view locations only.
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW, // Phase 2: view-only (§14).
      ...VIEW_KEYS('picking'), ...EXECUTE_KEYS('picking'),
    ],
  },
  {
    name: 'PACKER',
    description: 'Warehouse packer.',
    isSystem: true,
    applicationClass: 'OPERATIONAL',
    permissions: [
      ...ALL_STRUCT_VIEW, // Phase 1: view locations only.
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW, // Phase 2: view-only (§14).
      ...VIEW_KEYS('packing'), ...EXECUTE_KEYS('packing'),
    ],
  },
  {
    name: 'VIEWER',
    description: 'Read-only access.',
    isSystem: true,
    applicationClass: 'VIEWER',
    permissions: [
      ...ALL_STRUCT_VIEW, // Read-only on the whole physical structure.
      ...VIEW_KEYS('inventory'),
      ...PHASE2_VIEW, // Phase 2: read-only (§14).
      ...VIEW_KEYS('receiving'), ...VIEW_KEYS('stowing'),
      ...VIEW_KEYS('picking'), ...VIEW_KEYS('packing'), ...VIEW_KEYS('shipping'),
      'audit.view', 'expected_arrivals.view', 'shipments.view',
    ],
  },
];

// ------------------------------------------------------------------
// D-32: idempotent migration of legacy Phase-0 permission keys into the
// new granular model. Runs on every seed; safe to re-run.
//   legacy `warehouse.view`      -> `warehouses.view`
//   legacy `warehouse.manage`    -> all `warehouses.*` actions
//   legacy `locations.view`      -> `locations.view`
//   legacy `locations.manage`    -> all `locations.*` actions
// After a successful migration the legacy rows are removed (only if their
// target keys now exist). Roles are re-synced in the role loop below using
// the NEW keys, so anything that previously pointed at the legacy keys is
// re-mapped idempotently.
// ------------------------------------------------------------------
const LEGACY_GRANTS: Array<{ legacy: string; targets: string[] }> = [
  { legacy: 'warehouse.view', targets: ['warehouses.view'] },
  { legacy: 'warehouse.manage', targets: STRUCT_KEYS('warehouses', STRUCT_ACTIONS) },
  { legacy: 'locations.view', targets: ['locations.view'] },
  { legacy: 'locations.manage', targets: STRUCT_KEYS('locations', STRUCT_ACTIONS) },
];

async function migrateLegacyPermissions(permId: Record<string, string>) {
  for (const { legacy, targets } of LEGACY_GRANTS) {
    const legacyPerm = await prisma.permission.findUnique({ where: { key: legacy } });
    if (!legacyPerm) continue;
    // targetIds that are NOT the legacy row itself (avoids self-mapping when
    // a legacy key string coincides with a granular key, e.g. "locations.view").
    const targetIds = targets
      .map((k) => permId[k])
      .filter((id): id is string => !!id && id !== legacyPerm.id);
    // Move any role that held the legacy key to the new target keys.
    const holders = await prisma.rolePermission.findMany({ where: { permissionId: legacyPerm.id } });
    for (const h of holders) {
      await prisma.rolePermission.deleteMany({
        where: { roleId: h.roleId, permissionId: legacyPerm.id },
      });
      for (const tid of targetIds) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: h.roleId, permissionId: tid } },
          update: {},
          create: { roleId: h.roleId, permissionId: tid },
        });
      }
    }
    // Remove the legacy permission only if it is no longer referenced AND it
    // is not the same key that the granular catalog still needs (i.e. only
    // delete when the key is genuinely legacy-only).
    const stillHeld = await prisma.rolePermission.findFirst({ where: { permissionId: legacyPerm.id } });
    const isGranular = PERMISSIONS.some((p) => p.key === legacy);
    if (!stillHeld && !isGranular) {
      await prisma.permission.delete({ where: { id: legacyPerm.id } });
    }
    console.log(`  ~ reconciled legacy "${legacy}" -> ${targetIds.length ? targetIds.join(', ') : 'kept (granular)'}`);
  }
}

async function main() {
  const policy = seedPolicy(process.env);
  console.log('Seeding permissions...');
  const permByKey: Record<string, string> = {};
  for (const p of PERMISSIONS) {
    const created = await prisma.permission.upsert({
      where: { key: p.key },
      update: { resource: p.resource, action: p.action, description: p.description },
      create: p,
    });
    permByKey[p.key] = created.id;
  }

  console.log('Migrating legacy Phase-0 permissions (D-32)...');
  await migrateLegacyPermissions(permByKey);

  console.log('Seeding roles...');
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description, applicationClass: r.applicationClass },
      create: {
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        applicationClass: r.applicationClass,
      },
    });
    // Reconcile role permissions
    const existing = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
    const existingKeys = new Set(existing.map((e) => e.permissionId));
    const wantIds = r.permissions.map((k) => permByKey[k]).filter(Boolean);
    const toRemove = [...existingKeys].filter((id) => !wantIds.includes(id));
    const toAdd = wantIds.filter((id) => !existingKeys.has(id));
    const missingKeys = r.permissions.filter((k) => !permByKey[k]);
    if (missingKeys.length) console.log(`  ! ${r.name}: keys NOT found in catalog -> ${missingKeys.join(', ')}`);
    if (toRemove.length) await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { in: toRemove } } });
    if (toAdd.length) await prisma.rolePermission.createMany({ data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true });
    console.log(`  + ${r.name} (${r.permissions.length} permissions)`);
  }

  // Phase 2 BATCH — FEATURE FLAG (user order 2026-09-12: "console batch ON").
  // create-only: turning it OFF later from the admin survives every reboot.
  await prisma.systemSetting.upsert({
    where: { key: 'batch.enabled' },
    update: {},
    create: {
      key: 'batch.enabled',
      value: { value: true } as any,
      description: 'AYROVI Batch (Phase 2) master switch — ON by user order 2026-09-12.',
    },
  });

  // Optional initial SUPER_ADMIN from env
  const adminCode = process.env.INITIAL_ADMIN_CODE;
  const adminPass = process.env.INITIAL_ADMIN_PASSWORD;
  if (adminCode && adminPass) {
    console.log('Creating initial SUPER_ADMIN...');
    const sudo = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
    const hash = await bcrypt.hash(adminPass, 12);
    const existingAdmin = await prisma.user.findUnique({ where: { employeeCode: adminCode } });
    const admin = existingAdmin ?? await prisma.user.create({
      data: { name: 'System Administrator', employeeCode: adminCode, email: adminCode,
        passwordHash: hash, credentialMode: 'PASSWORD', status: 'ACTIVE' },
    });
    if (sudo && !existingAdmin) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: admin.id, roleId: sudo.id } },
        update: {},
        create: { userId: admin.id, roleId: sudo.id },
      });
    }
    console.log(`  + SUPER_ADMIN user created with employeeCode="${adminCode}".`);
  } else {
    console.log('Skipping initial admin (set INITIAL_ADMIN_CODE / INITIAL_ADMIN_PASSWORD to create one).');
  }

  // ------------------------------------------------------------------
  // Phase 1 — TEST/SEED physical structure (D-30 §30). Clearly labelled as
  // test data only; NOT real warehouse data.
  // ------------------------------------------------------------------
  const seed = async () => {
    const wh = await prisma.warehouse.upsert({
      where: { code: 'TUN-MAIN' },
      update: { name: 'Main Warehouse (TEST SEED)', description: 'Phase 1 test/seed physical structure.' },
      create: { code: 'TUN-MAIN', name: 'Main Warehouse (TEST SEED)', description: 'Phase 1 test/seed physical structure.' },
    });
    const mk = async (model: 'zone' | 'aisle' | 'rack' | 'level', parentId: string, code: string, extra: Record<string, unknown> = {}) => {
      const uniq = model === 'zone' ? { warehouseId_code: { warehouseId: parentId, code } }
        : model === 'aisle' ? { zoneId_code: { zoneId: parentId, code } }
        : model === 'rack' ? { aisleId_code: { aisleId: parentId, code } }
        : { rackId_code: { rackId: parentId, code } };
      const parentField = model === 'zone' ? 'warehouseId' : model === 'aisle' ? 'zoneId' : model === 'rack' ? 'aisleId' : 'rackId';
      const data = model === 'level' ? { code, ...extra } : { code, name: code, ...extra };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (prisma as any)[model].upsert({ where: uniq, update: data, create: { ...data, [parentField]: parentId } });
    };

    for (const zc of ['SHOES', 'CLOTHING']) {
      const zone = await mk('zone', wh.id, zc);
      const aisle = await mk('aisle', zone.id, 'A01');
      const rack = await mk('rack', aisle.id, 'R01');
      const level = await mk('level', rack.id, 'L01', { levelNumber: 1 });
      const level2 = await mk('level', rack.id, 'L02', { levelNumber: 2 });
      // A couple of sample locations for the test hierarchy.
      await prisma.location.upsert({
        where: { locationCode: `${wh.code}-${zc}-A01-R01-L01` },
        update: {},
        create: {
          warehouseId: wh.id, zoneId: zone.id, aisleId: aisle.id, rackId: rack.id,
          levelId: level.id, locationCode: `${wh.code}-${zc}-A01-R01-L01`,
          barcodeValue: `${wh.code}-${zc}-A01-R01-L01`, locationType: 'STORAGE',
        },
      });
      await prisma.location.upsert({
        where: { locationCode: `${wh.code}-${zc}-A01-R01-L02` },
        update: {},
        create: {
          warehouseId: wh.id, zoneId: zone.id, aisleId: aisle.id, rackId: rack.id,
          levelId: level2.id, locationCode: `${wh.code}-${zc}-A01-R01-L02`,
          barcodeValue: `${wh.code}-${zc}-A01-R01-L02`, locationType: 'STORAGE',
        },
      });
    }
    console.log('  + TEST/SEED physical structure created (TUN-MAIN: SHOES, CLOTHING).');
  };
  if (policy.demo) await seed();

  // ------------------------------------------------------------------
  // CATEGORY MASTER — the APPROVED §3 taxonomy (Master Blueprint). This is
  // the canonical starting configuration; admins extend it via /categories.
  // Upserts only: an admin-modified taxonomy is never overwritten.
  // ------------------------------------------------------------------
  const taxonomySeed = async () => {
    const taxonomy: Array<{ code: string; name: string; subcategories: string[] }> = [
      {
        code: 'CLOTHING', name: 'Clothing',
        subcategories: ['SHIRTS', 'T_SHIRTS', 'PANTS', 'JEANS', 'JACKETS', 'DRESSES', 'SWEATERS', 'OTHER_CLOTHING'],
      },
      {
        code: 'SHOES', name: 'Shoes',
        subcategories: ['SNEAKERS', 'SPORTS', 'BOOTS', 'SANDALS', 'FORMAL', 'OTHER_SHOES'],
      },
      {
        code: 'ACCESSORIES', name: 'Accessories',
        subcategories: ['BAGS', 'BELTS', 'HATS', 'SCARVES', 'WALLETS', 'OTHER_ACCESSORIES'],
      },
      { code: 'OTHER', name: 'Other', subcategories: ['UNCLASSIFIED'] },
    ];
    for (const cat of taxonomy) {
      await prisma.categoryMaster.upsert({
        where: { code: cat.code },
        update: {}, // never overwrite admin-managed taxonomy
        create: { code: cat.code, name: cat.name, subcategories: cat.subcategories, status: 'ACTIVE' },
      });
    }

    // TEST/SEED sorting CONFIGURATION for the seeded structure: map the two
    // seeded categories to their same-named TUN-MAIN zones. Pure data — the
    // sorting workflow only ever reads CategoryZoneMapping.
    const wh = await prisma.warehouse.findUnique({ where: { code: 'TUN-MAIN' } });
    if (wh && policy.demo) {
      for (const code of ['SHOES', 'CLOTHING']) {
        const category = await prisma.categoryMaster.findUnique({ where: { code } });
        const zone = await prisma.zone.findUnique({ where: { warehouseId_code: { warehouseId: wh.id, code } } });
        if (category && zone) {
          await prisma.categoryZoneMapping.upsert({
            where: { categoryId_zoneId: { categoryId: category.id, zoneId: zone.id } },
            update: {},
            create: { categoryId: category.id, zoneId: zone.id },
          });
        }
      }
    }
    console.log('  + Category Master initialized; existing configuration preserved.');
  };
  await taxonomySeed();

  // ------------------------------------------------------------------
  // WAREHOUSE OS — stations + a floor worker so role-aware terminal routing
  // (§2/§3) can be exercised end to end. Clearly labelled TEST/SEED data.
  // ------------------------------------------------------------------
  const osSeed = async () => {
    const wh = await prisma.warehouse.findUnique({ where: { code: 'TUN-MAIN' } });

    const stations: Array<{
      code: string;
      name: string;
      department: 'RECEIVING' | 'SORTING' | 'PUTAWAY' | 'PACKING' | 'DISPATCH' | 'STAGING' | 'BATCH';
      capabilities: Array<'CAMERA' | 'BARCODE_SCANNER' | 'QR_SCANNER' | 'OCR' | 'PRINTER' | 'SCALE'>;
    }> = [
      { code: 'ST-REC-01', name: 'Receiving Dock 1', department: 'RECEIVING', capabilities: ['CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'SCALE'] },
      { code: 'ST-REC-02', name: 'Receiving Dock 2', department: 'RECEIVING', capabilities: ['CAMERA', 'BARCODE_SCANNER', 'OCR'] },
      { code: 'ST-SRT-01', name: 'Sorting Bench 1', department: 'SORTING', capabilities: ['CAMERA', 'BARCODE_SCANNER'] },
      { code: 'ST-PCK-01', name: 'Packing Bench 1', department: 'PACKING', capabilities: ['CAMERA', 'PRINTER', 'SCALE'] },
      { code: 'ST-SHP-01', name: 'Shipping Dock 1', department: 'DISPATCH', capabilities: ['CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER'] },
      // AYROVI BATCH (owner order 2026-09-12): the batch lane has its OWN
      // department — BATCH — with real stations created/managed from the
      // admin Stations page (prod: BATCH-01). DISPATCH-reuse was checked and
      // rejected (outbound-only).
      { code: 'BATCH-01', name: 'Batch', department: 'BATCH', capabilities: ['CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'PRINTER'] },
      // Master Order §11: the temporary storage position CLOSED receiving
      // totes are staged at before the sorting step.
      { code: 'ST-STG-01', name: 'Temporary Storage 1', department: 'STAGING', capabilities: ['CAMERA', 'BARCODE_SCANNER'] },
    ];
    for (const st of stations) {
      await prisma.station.upsert({
        where: { code: st.code },
        update: { name: st.name, department: st.department, capabilities: st.capabilities, warehouseId: wh?.id ?? null },
        create: { ...st, warehouseId: wh?.id ?? null },
      });
    }

    // Master Order §11: the station → zone relationship is BACKEND/ADMIN
    // configuration (Station.zoneId). The STAGING zone is where a full
    // container physically rests until sorting; it must exist before a
    // STAGING station can be used by the stageContainer workflow.
    if (wh) {
      const stgZone = await prisma.zone.upsert({
        where: { warehouseId_code: { warehouseId: wh.id, code: 'STG' } },
        update: {},
        create: { warehouseId: wh.id, code: 'STG', name: 'Temporary Storage Zone' },
      });
      await prisma.station.update({
        where: { code: 'ST-STG-01' },
        data: { zoneId: stgZone.id },
      });
    }

    // MASTER ORDER — WORKER -> STATION -> OPERATION -> WORK -> TASK.
    // One demo worker per station, each carrying only the roles of the
    // operation performed AT that station. The station binding is enforcing
    // (terminal + assignment pickers gate on station.department), so these
    // five workers cover the whole reference chain on the floor:
    //   ST-REC-01 Receiving · ST-STG-01 Temporary Storage · ST-SRT-01 Sorting
    //   ST-PCK-01 Packing · ST-SHP-01 Shipping-Dispatch
    const workerCode = process.env.SEED_WORKER_CODE ?? 'WORKER001';
    const workerPass = process.env.SEED_WORKER_PASSWORD!;
    const hash = await bcrypt.hash(workerPass, 12);
    const workforce: Array<{ code: string; name: string; station: string; roles: string[] }> = [
      {
        code: workerCode,
        name: 'TEST RECEIVING WORKER',
        station: 'ST-REC-01',
        roles: ['INBOUND_WORKER', 'RECEIVING_WORKER'],
      },
      {
        code: 'WORKER002',
        name: 'TEST TEMPORARY STORAGE WORKER',
        station: 'ST-STG-01',
        roles: ['TEMP_STORAGE_WORKER'],
      },
      {
        code: 'WORKER003',
        name: 'TEST SORTING WORKER',
        station: 'ST-SRT-01',
        roles: ['SORTING_WORKER', 'PICKER'],
      },
      {
        code: 'WORKER004',
        name: 'TEST PACKING WORKER',
        station: 'ST-PCK-01',
        roles: ['PACKING_WORKER'],
      },
      {
        code: 'WORKER005',
        name: 'TEST SHIPPING WORKER',
        station: 'ST-SHP-01',
        roles: ['SHIPPING_WORKER'],
      },
      {
        code: 'WORKER006',
        name: 'TEST BATCH WORKER',
        station: 'BATCH-01',
        roles: ['BATCH_WORKER'],
      },
    ];
    for (const w of workforce) {
      const user = await prisma.user.upsert({
        where: { employeeCode: w.code },
        update: { name: w.name, passwordHash: hash, credentialMode: 'PASSWORD', status: 'ACTIVE' },
        create: {
          name: w.name,
          employeeCode: w.code,
          email: w.code,
          passwordHash: hash,
          credentialMode: 'PASSWORD',
          status: 'ACTIVE',
        },
      });
      for (const roleName of w.roles) {
        const role = await prisma.role.findUnique({ where: { name: roleName } });
        if (role) {
          await prisma.userRole.upsert({
            where: { userId_roleId: { userId: user.id, roleId: role.id } },
            update: {},
            create: { userId: user.id, roleId: role.id },
          });
        }
      }
      // The worker is bound to exactly one station: this binding is what the
      // terminal picker reads to decide which OPERATIONS are on the floor.
      await prisma.station.updateMany({
        where: { code: w.station },
        data: { assignedWorkerId: user.id },
      });
    }
    console.log('  + Explicit demo stations and worker initialized (credentials are not logged).');
  };
  if (policy.demo) await osSeed();

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
