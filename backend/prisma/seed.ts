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

import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// ---------------------------------------------------------------
// Permission catalog (Phase 0)
// The `execute` permissions for receiving/stowing/picking/packing/
// shipping are defined HERE so the architecture is ready, but Phase 0
// does NOT implement the underlying workflows.
// ---------------------------------------------------------------
const PERMISSIONS: Array<{ key: string; resource: string; action: string; description: string }> = [
  // Warehouse
  { key: 'warehouse.view', resource: 'warehouse', action: 'view', description: 'View warehouse core information' },
  { key: 'warehouse.manage', resource: 'warehouse', action: 'manage', description: 'Manage warehouse core information' },

  // Locations (Phase 1 will implement; permission ready now)
  { key: 'locations.view', resource: 'locations', action: 'view', description: 'View locations' },
  { key: 'locations.manage', resource: 'locations', action: 'manage', description: 'Manage locations' },

  // Inventory (Phase 1+ will implement; permission ready now)
  { key: 'inventory.view', resource: 'inventory', action: 'view', description: 'View inventory' },
  { key: 'inventory.manage', resource: 'inventory', action: 'manage', description: 'Manage inventory' },

  // Inbound (permission ready; workflow deferred)
  { key: 'receiving.view', resource: 'receiving', action: 'view', description: 'View receiving operations' },
  { key: 'receiving.execute', resource: 'receiving', action: 'execute', description: 'Execute receiving operations' },

  { key: 'stowing.view', resource: 'stowing', action: 'view', description: 'View stowing operations' },
  { key: 'stowing.execute', resource: 'stowing', action: 'execute', description: 'Execute stowing operations' },

  // Outbound (permission ready; workflow deferred)
  { key: 'picking.view', resource: 'picking', action: 'view', description: 'View picking operations' },
  { key: 'picking.execute', resource: 'picking', action: 'execute', description: 'Execute picking operations' },

  { key: 'packing.view', resource: 'packing', action: 'view', description: 'View packing operations' },
  { key: 'packing.execute', resource: 'packing', action: 'execute', description: 'Execute packing operations' },

  { key: 'shipping.view', resource: 'shipping', action: 'view', description: 'View shipping operations' },
  { key: 'shipping.execute', resource: 'shipping', action: 'execute', description: 'Execute shipping operations' },

  // Administration
  { key: 'users.view', resource: 'users', action: 'view', description: 'View users' },
  { key: 'users.manage', resource: 'users', action: 'manage', description: 'Create, update and disable users' },

  { key: 'roles.view', resource: 'roles', action: 'view', description: 'View roles' },
  { key: 'roles.manage', resource: 'roles', action: 'manage', description: 'Create and manage roles and role permissions' },

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

const ROLES: Array<{ name: string; description: string; isSystem: boolean; permissions: string[] }> = [
  {
    name: 'SUPER_ADMIN',
    description: 'Full, unrestricted access to the whole system.',
    isSystem: true,
    permissions: ALL,
  },
  {
    name: 'WAREHOUSE_ADMIN',
    description: 'Operational administration of the warehouse.',
    isSystem: true,
    permissions: [
      ...ALL.filter((k) => k.startsWith('warehouse.') || k.startsWith('locations.') || k.startsWith('inventory.')),
      ...MANAGE_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      ...MANAGE_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
      ...MANAGE_KEYS('picking'), ...EXECUTE_KEYS('picking'),
      ...MANAGE_KEYS('packing'), ...EXECUTE_KEYS('packing'),
      ...MANAGE_KEYS('shipping'), ...EXECUTE_KEYS('shipping'),
      'users.view', 'users.manage', 'roles.view', 'roles.manage', 'audit.view',
      'system.view', 'system.manage', 'api_clients.view', 'api_clients.manage',
    ],
  },
  {
    name: 'WAREHOUSE_MANAGER',
    description: 'Day-to-day warehouse management without full system admin.',
    isSystem: true,
    permissions: [
      ...VIEW_KEYS('warehouse'), ...MANAGE_KEYS('warehouse'),
      ...VIEW_KEYS('locations'), ...MANAGE_KEYS('locations'),
      ...VIEW_KEYS('inventory'), ...MANAGE_KEYS('inventory'),
      ...VIEW_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      ...VIEW_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
      ...VIEW_KEYS('picking'), ...EXECUTE_KEYS('picking'),
      ...VIEW_KEYS('packing'), ...EXECUTE_KEYS('packing'),
      ...VIEW_KEYS('shipping'), ...EXECUTE_KEYS('shipping'),
      'users.view', 'roles.view', 'audit.view', 'system.view', 'api_clients.view',
    ],
  },
  {
    name: 'INBOUND_WORKER',
    description: 'Warehouse floor worker for inbound (receiving/stowing).',
    isSystem: true,
    permissions: [
      ...VIEW_KEYS('warehouse'), ...VIEW_KEYS('locations'),
      ...VIEW_KEYS('inventory'),
      ...VIEW_KEYS('receiving'), ...EXECUTE_KEYS('receiving'),
      ...VIEW_KEYS('stowing'), ...EXECUTE_KEYS('stowing'),
    ],
  },
  {
    name: 'PICKER',
    description: 'Warehouse picker.',
    isSystem: true,
    permissions: [
      ...VIEW_KEYS('warehouse'), ...VIEW_KEYS('locations'), ...VIEW_KEYS('inventory'),
      ...VIEW_KEYS('picking'), ...EXECUTE_KEYS('picking'),
    ],
  },
  {
    name: 'PACKER',
    description: 'Warehouse packer.',
    isSystem: true,
    permissions: [
      ...VIEW_KEYS('warehouse'), ...VIEW_KEYS('inventory'),
      ...VIEW_KEYS('packing'), ...EXECUTE_KEYS('packing'),
    ],
  },
  {
    name: 'VIEWER',
    description: 'Read-only access.',
    isSystem: true,
    permissions: [
      ...VIEW_KEYS('warehouse'), ...VIEW_KEYS('locations'), ...VIEW_KEYS('inventory'),
      ...VIEW_KEYS('receiving'), ...VIEW_KEYS('stowing'),
      ...VIEW_KEYS('picking'), ...VIEW_KEYS('packing'), ...VIEW_KEYS('shipping'),
      'audit.view',
    ],
  },
];

async function main() {
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

  console.log('Seeding roles...');
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description },
      create: { name: r.name, description: r.description, isSystem: r.isSystem },
    });
    // Reconcile role permissions
    const existing = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
    const existingKeys = new Set(existing.map((e) => e.permissionId));
    const wantIds = r.permissions.map((k) => permByKey[k]).filter(Boolean);
    const toRemove = [...existingKeys].filter((id) => !wantIds.includes(id));
    const toAdd = wantIds.filter((id) => !existingKeys.has(id));
    if (toRemove.length) await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { in: toRemove } } });
    if (toAdd.length) await prisma.rolePermission.createMany({ data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })) });
    console.log(`  + ${r.name} (${r.permissions.length} permissions)`);
  }

  // Optional initial SUPER_ADMIN from env
  const adminCode = process.env.INITIAL_ADMIN_CODE;
  const adminPass = process.env.INITIAL_ADMIN_PASSWORD;
  if (adminCode && adminPass) {
    console.log('Creating initial SUPER_ADMIN...');
    const sudo = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
    const hash = await bcrypt.hash(adminPass, 12);
    const admin = await prisma.user.upsert({
      where: { employeeCode: adminCode },
      update: {
        name: 'System Administrator',
        passwordHash: hash,
        credentialMode: 'PASSWORD',
        status: 'ACTIVE',
      },
      create: {
        name: 'System Administrator',
        employeeCode: adminCode,
        email: adminCode,
        passwordHash: hash,
        credentialMode: 'PASSWORD',
        status: 'ACTIVE',
      },
    });
    if (sudo) {
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
