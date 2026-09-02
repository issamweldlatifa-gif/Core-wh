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
  { key: 'dashboard', label: 'Dashboard', path: '/' },
  { key: 'receiving', label: 'Receiving', path: '/terminal/receiving', permission: 'receiving.execute' },
  { key: 'putaway', label: 'Putaway', path: '/terminal/putaway', permission: 'stowing.execute' },
  { key: 'admin', label: 'Control Center', path: '/admin', permission: 'operations.view' },
  { key: 'expected-arrivals', label: 'Expected Arrivals', path: '/expected-arrivals', permission: 'expected_arrivals.view' },
  { key: 'warehouse', label: 'Warehouse', path: '/warehouse', permission: 'warehouses.view' },
  { key: 'users', label: 'Users', path: '/users', permission: 'users.view' },
  { key: 'roles', label: 'Roles & Permissions', path: '/roles', permission: 'roles.view' },
  { key: 'audit', label: 'Audit Log', path: '/audit', permission: 'audit.view' },
  { key: 'system', label: 'System Settings', path: '/system', permission: 'system.view' },
  { key: 'profile', label: 'Profile', path: '/profile' },
  // Future operational modules (Stowing beyond putaway, Picking, Shipping,
  // Inventory, Cycle Count, ...) are added here alongside their workspaces.
];
