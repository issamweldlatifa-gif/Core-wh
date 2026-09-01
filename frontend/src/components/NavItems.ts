/**
 * Navigation registry. Every nav item is tied to the minimum permission that
 * grants visibility. The application shell filters these by the current
 * user's permissions, so an employee never sees a module they cannot access
 * and the navigation is driven by RBAC, not hard-coded roles.
 *
 * Phase 0 scope: only the Core-facing views are surfaced. Operational modules
 * (Receiving, Picking, ...) are intentionally NOT listed here yet — they
 * belong to later phases and will be added alongside their workflows.
 */
export interface NavItem {
  key: string;
  label: string;
  path: string;
  /** Permission(s) required to see this item. */
  permission?: string;
  /** Only show for those holding the given view permission. */
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', permission: 'warehouses.view' },
  { key: 'receiving', label: 'Receiving', path: '/warehouse/receiving', permission: 'receiving.view' },
  { key: 'expected-arrivals', label: 'Expected Arrivals', path: '/expected-arrivals', permission: 'expected_arrivals.view' },
  { key: 'warehouse', label: 'Warehouse', path: '/warehouse', permission: 'warehouses.view' },
  { key: 'users', label: 'Users', path: '/users', permission: 'users.view' },
  { key: 'roles', label: 'Roles & Permissions', path: '/roles', permission: 'roles.view' },
  { key: 'audit', label: 'Audit Log', path: '/audit', permission: 'audit.view' },
  { key: 'system', label: 'System Settings', path: '/system', permission: 'system.view' },
  // Future operational modules are added here in later phases alongside
  // their workflows (NOT in Phase 0).
];
