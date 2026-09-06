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
  /**
   * Application surface this item belongs to (Order #3). Worker workspaces
   * (the terminal tasks) are WORKER_NATIVE — an ADMIN_WEB session monitors
   * them from the Control Center instead; admin items are ADMIN_WEB. Items
   * with no surface are shared (permission alone decides).
   */
  surface?: 'ADMIN_WEB' | 'WORKER_NATIVE';
  /** Only show for those holding the given view permission. */
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/' },
  { key: 'receiving', label: 'Receiving', path: '/terminal/receiving', permission: 'receiving.execute', surface: 'WORKER_NATIVE' },
  { key: 'putaway', label: 'Putaway', path: '/terminal/putaway', permission: 'stowing.execute', surface: 'WORKER_NATIVE' },
  { key: 'admin', label: 'Control Center', path: '/admin', permission: 'operations.view' },
  { key: 'expected-arrivals', label: 'Expected Arrivals', path: '/expected-arrivals', permission: 'expected_arrivals.view' },
  { key: 'categories', label: 'Categories', path: '/categories', permission: 'inventory.view' },
  { key: 'warehouse', label: 'Warehouse', path: '/warehouse', permission: 'warehouses.view' },
  { key: 'users', label: 'Users', path: '/users', permission: 'users.view' },
  { key: 'roles', label: 'Roles & Permissions', path: '/roles', permission: 'roles.view' },
  { key: 'audit', label: 'Audit Log', path: '/audit', permission: 'audit.view' },
  { key: 'system', label: 'System Settings', path: '/system', permission: 'system.view' },
  { key: 'profile', label: 'Profile', path: '/profile' },
  // Future operational modules (Stowing beyond putaway, Picking, Shipping,
  // Inventory, Cycle Count, ...) are added here alongside their workflows.
];

/**
 * RBAC + application-surface nav filter (Order #3). Permission decides WHAT a
 * session may see; the session's `application` (server truth from /auth/me)
 * decides WHICH app surface it belongs to. A WORKER_NATIVE workspace link is
 * never offered to an ADMIN_WEB session — that surface's API is reserved for
 * the Worker app and would be rejected with 403.
 */
export function filterNavItems(
  items: NavItem[],
  hasPermission: (perm: string) => boolean,
  application?: 'ADMIN_WEB' | 'WORKER_NATIVE',
): NavItem[] {
  return items.filter(
    (item) =>
      (!item.permission || hasPermission(item.permission)) &&
      (!item.surface || !application || item.surface === application),
  );
}
