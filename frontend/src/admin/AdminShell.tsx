import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
// Identity, brand and logout live in the GLOBAL shell — this sidebar is
// pure control-center navigation (UX: one shell, role-aware content).

/**
 * Admin Control Center shell (spec §6/§34/§43).
 *
 * Deliberately a different information architecture from the Worker Terminal
 * (§45): a persistent dense sidebar, compact type, and every operational
 * module one click away — because the admin monitors and controls, while the
 * worker executes (§49).
 */

interface NavEntry {
  to: string;
  label: string;
  permission?: string;
  group: string;
}

const NAV: NavEntry[] = [
  { to: '/admin', label: 'Control Center', permission: 'operations.view', group: 'Operations' },
  { to: '/admin/workers', label: 'Workers', permission: 'operations.view', group: 'Operations' },
  { to: '/admin/stations', label: 'Stations', permission: 'stations.view', group: 'Operations' },
  { to: '/admin/exceptions', label: 'Exceptions', permission: 'operations.view', group: 'Operations' },
  { to: '/admin/corrections', label: 'Corrections', permission: 'operations.view', group: 'Operations' },
  { to: '/admin/traceability', label: 'Traceability', permission: 'operations.view', group: 'Operations' },

  { to: '/admin/arrivals', label: 'Expected Arrivals', permission: 'expected_arrivals.view', group: 'Inbound' },
  { to: '/admin/receiving', label: 'Receiving', permission: 'receiving.view', group: 'Inbound' },

  { to: '/admin/orders', label: 'Orders', permission: 'operations.view', group: 'Outbound' },
  { to: '/admin/shipments', label: 'Shipments', permission: 'operations.view', group: 'Outbound' },

  { to: '/admin/structure', label: 'Structure', permission: 'warehouses.view', group: 'Warehouse' },

  { to: '/admin/users', label: 'Users', permission: 'users.view', group: 'System' },
  { to: '/admin/roles', label: 'Roles', permission: 'roles.view', group: 'System' },
  { to: '/admin/audit', label: 'Audit Log', permission: 'audit.view', group: 'System' },
  { to: '/admin/system', label: 'Settings', permission: 'system.view', group: 'System' },
];

export default function AdminShell() {
  const { me, loading, hasPermission } = useAuth();

  if (loading) {
    return (
      <div className="os-root theme-admin ac-boot">
        <div className="os-muted">loading control center…</div>
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;

  const visible = NAV.filter((n) => !n.permission || hasPermission(n.permission));
  const groups = [...new Set(visible.map((n) => n.group))];

  return (
    <div className="os-root theme-admin ac gs-flush">
      <aside className="ac-side">
        <div className="ac-scope">CONTROL CENTER</div>

        <nav className="ac-nav">
          {groups.map((g) => (
            <div key={g} className="ac-nav-group">
              <div className="ac-nav-title">{g}</div>
              {visible
                .filter((n) => n.group === g)
                .map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === '/admin'}
                    className={({ isActive }) => `ac-link${isActive ? ' is-active' : ''}`}
                  >
                    {n.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="ac-main">
        <Outlet />
      </main>
    </div>
  );
}
