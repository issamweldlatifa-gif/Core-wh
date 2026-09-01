import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Icon, type IconName } from '../ui';
import type { ReactNode } from 'react';

/**
 * Admin Control Center shell.
 *
 * Deliberately a different information architecture from the Worker
 * Terminal: a persistent sidebar, compact type, and every module one click
 * away — because the admin monitors and controls, while the worker executes.
 * All management modules render inside this one shell so the product has a
 * single professional surface (no legacy dashboard generation remains).
 */

interface NavEntry {
  to: string;
  label: string;
  permission?: string;
  group: string;
  icon: IconName;
}

const NAV: NavEntry[] = [
  { to: '/admin', label: 'Control Center', permission: 'operations.view', group: 'Operations', icon: 'grid' },
  { to: '/admin/workers', label: 'Workers', permission: 'operations.view', group: 'Operations', icon: 'users' },
  { to: '/admin/stations', label: 'Stations', permission: 'stations.view', group: 'Operations', icon: 'station' },
  { to: '/admin/exceptions', label: 'Exceptions', permission: 'operations.view', group: 'Operations', icon: 'alert' },
  { to: '/admin/corrections', label: 'Corrections', permission: 'operations.view', group: 'Operations', icon: 'wrench' },

  { to: '/expected-arrivals', label: 'Expected Arrivals', permission: 'expected_arrivals.view', group: 'Inbound', icon: 'inbox' },
  { to: '/warehouse/receiving', label: 'Receiving Terminal', permission: 'receiving.view', group: 'Inbound', icon: 'scan' },

  { to: '/warehouse/structure', label: 'Structure', permission: 'warehouses.view', group: 'Warehouse', icon: 'layers' },
  { to: '/warehouse/warehouses', label: 'Warehouses', permission: 'warehouses.view', group: 'Warehouse', icon: 'box' },

  { to: '/users', label: 'Users', permission: 'users.view', group: 'System', icon: 'idcard' },
  { to: '/roles', label: 'Roles & Permissions', permission: 'roles.view', group: 'System', icon: 'shield' },
  { to: '/audit', label: 'Audit Log', permission: 'audit.view', group: 'System', icon: 'scroll' },
  { to: '/system', label: 'Settings', permission: 'system.view', group: 'System', icon: 'settings' },
];

function NavIcon({ name }: { name: IconName }): ReactNode {
  return <Icon name={name} size={17} />;
}

export default function AdminShell() {
  const { me, loading, logoutFn, hasPermission } = useAuth();

  if (loading) {
    return (
      <div className="os-root theme-admin ac-boot">
        <span className="os-spinner" />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;

  const visible = NAV.filter((n) => !n.permission || hasPermission(n.permission));
  const groups = [...new Set(visible.map((n) => n.group))];

  return (
    <div className="os-root theme-admin ac">
      <aside className="ac-side">
        <div className="ac-brand">
          <span className="ac-brand-mark">AY</span>
          <span className="ac-brand-text">
            <span className="ac-brand-main">AYROVI</span>
            <span className="ac-brand-sub">Control Center</span>
          </span>
        </div>

        <nav className="ac-nav" aria-label="Admin navigation">
          {groups.map((g) => (
            <div key={g} className="ac-nav-group">
              <div className="ac-nav-title">{g}</div>
              {visible
                .filter((n) => n.group === g)
                .map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === '/admin' || n.to === '/warehouse/structure'}
                    className={({ isActive }) => `ac-link${isActive ? ' is-active' : ''}`}
                  >
                    <NavIcon name={n.icon} />
                    {n.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>

        <div className="ac-user">
          <div className="ac-user-name">{me.user.name}</div>
          <div className="ac-user-meta os-muted">{me.user.employeeCode} · {me.roles.join(', ')}</div>
          <button type="button" className="os-btn os-btn--danger" onClick={() => void logoutFn()}>
            <Icon name="logout" size={16} /> Log out
          </button>
        </div>
      </aside>

      <main className="ac-main">
        <Outlet />
      </main>
    </div>
  );
}
