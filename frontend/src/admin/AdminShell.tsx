import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import client from '../api/client';

/**
 * ADMIN CONTROL CENTER V1 shell — warehouse control room.
 *
 * HEADER (fixed): brand · CONTROL CENTER · WAREHOUSE: <code> · STATUS ●
 * SYSTEM ONLINE · role · alert count. (The user menu itself lives in the
 * global shell header just above — identity is never duplicated.)
 * SIDEBAR: CONTROL / WORKFORCE / WAREHOUSE / FULFILLMENT / MONITORING / SYSTEM.
 *
 * Every figure in the header is backend-derived (overview counters +
 * warehouse registry); nothing is invented.
 */

interface NavEntry {
  to: string;
  label: string;
  permission?: string;
  group: string;
}

const NAV: NavEntry[] = [
  // CONTROL --------------------------------------------------------------
  { to: '/admin', label: 'Overview', permission: 'operations.view', group: 'Control' },
  { to: '/admin/operations', label: 'Operations', permission: 'operations.view', group: 'Control' },
  { to: '/admin/arrivals', label: 'Expected Arrivals', permission: 'expected_arrivals.view', group: 'Control' },

  // WORKFORCE ------------------------------------------------------------
  { to: '/admin/workers', label: 'Workers', permission: 'operations.view', group: 'Workforce' },
  { to: '/admin/stations', label: 'Stations', permission: 'stations.view', group: 'Workforce' },
  { to: '/admin/tasks', label: 'Tasks', permission: 'operations.view', group: 'Workforce' },

  // WAREHOUSE ------------------------------------------------------------
  { to: '/admin/structure', label: 'Warehouse Tree', permission: 'warehouses.view', group: 'Warehouse' },
  { to: '/admin/containers', label: 'Containers', permission: 'receiving.view', group: 'Warehouse' },
  { to: '/admin/categories', label: 'Categories', permission: 'inventory.view', group: 'Warehouse' },

  // FULFILLMENT ----------------------------------------------------------
  { to: '/admin/orders', label: 'Orders', permission: 'operations.view', group: 'Fulfillment' },
  { to: '/admin/shipments', label: 'Shipments', permission: 'operations.view', group: 'Fulfillment' },

  // MONITORING -----------------------------------------------------------
  { to: '/admin/exceptions', label: 'Exceptions', permission: 'operations.view', group: 'Monitoring' },
  { to: '/admin/activity', label: 'Live Activity', permission: 'audit.view', group: 'Monitoring' },
  { to: '/admin/traceability', label: 'Audit / Trace', permission: 'operations.view', group: 'Monitoring' },
  { to: '/admin/corrections', label: 'Corrections', permission: 'operations.view', group: 'Monitoring' },

  // SYSTEM ---------------------------------------------------------------
  { to: '/admin/users', label: 'Users', permission: 'users.view', group: 'System' },
  { to: '/admin/roles', label: 'Roles', permission: 'roles.view', group: 'System' },
  { to: '/admin/system', label: 'Settings', permission: 'system.view', group: 'System' },
];

/** Light header telemetry — ONE request, refreshed on a slow interval. */
function useHeaderStatus(enabled: boolean) {
  const [state, setState] = useState<{
    warehouse: string | null;
    online: boolean;
    alerts: number | null;
  }>({ warehouse: null, online: true, alerts: null });

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    async function load() {
      try {
        const [wh, ov] = await Promise.all([
          client.get('/v1/warehouses').then((r) => r.data).catch(() => null),
          client.get('/v1/operations/overview').then((r) => r.data).catch(() => null),
        ]);
        if (stop) return;
        const list: Array<{ code: string; status: string }> = Array.isArray(wh) ? wh : [];
        const main = list.find((w) => w.code === 'TUN-MAIN') ?? list[0] ?? null;
        setState({
          warehouse: main?.code ?? null,
          online: ov !== null,
          alerts: ov ? ov.counters.openExceptions : null,
        });
      } catch {
        if (!stop) setState((s) => ({ ...s, online: false }));
      }
    }
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [enabled]);

  return state;
}

export default function AdminShell() {
  const { me, loading, hasPermission } = useAuth();
  const canView = !!me && hasPermission('operations.view');
  const head = useHeaderStatus(canView);

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
  const attention = (head.alerts ?? 0) > 0;

  return (
    <div className="os-root theme-admin ac-wrap gs-flush">
      {/* ---- FIXED CONTROL-ROOM HEADER ---------------------------------- */}
      <header className="ac-topbar">
        <div className="ac-topbar-brand">
          <span className="ac-tb-main">AYROVI</span>
          <span className="ac-tb-sub">// WAREHOUSE CORE</span>
        </div>
        <div className="ac-topbar-scope">CONTROL CENTER</div>
        <div className="ac-topbar-tags">
          <span className="ac-tb-kv">
            WAREHOUSE: <b>{head.warehouse ?? '—'}</b>
          </span>
          <span className={`ac-tb-kv ${attention ? 'is-warn' : 'is-ok'}`}>
            STATUS: {attention ? '● ATTENTION' : '● OPERATIONAL'}
          </span>
          <span className={`ac-tb-kv ${head.online ? 'is-ok' : 'is-err'}`}>
            {head.online ? 'SYSTEM ONLINE' : 'SYSTEM UNREACHABLE'}
          </span>
          <span className="ac-tb-kv">{me.roles[0] ?? 'ADMIN'}</span>
          <NavLink to="/admin/exceptions" className={`ac-tb-kv ac-tb-alerts${attention ? ' is-err' : ''}`}>
            ALERTS: {head.alerts ?? '—'}
          </NavLink>
        </div>
      </header>

      <div className="ac">
        <aside className="ac-side">
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
    </div>
  );
}
