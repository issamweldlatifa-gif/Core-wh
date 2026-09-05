import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { adminApi, type OpsOverview } from './api';
import type { ControlData } from './controlData';

/**
 * ADMIN CONTROL CENTER — unified shell (HEADER + SIDEBAR + MAIN).
 *
 * Information-dense, technical, deliberately different information
 * architecture from the Worker Terminal: the admin monitors and controls,
 * so every module is one click away and the top bar carries the live floor
 * state (warehouse, system, role, alert count) at all times.
 *
 * Identity & navigation: the whole /admin area is a dedicated workspace
 * (routes sit outside the generic application shell). The top bar owns the
 * AYROVI identity, the user menu and logout.
 */

interface NavEntry {
  to: string;
  label: string;
  group: string;
  permission?: string;
  /** Cross-module link: leaves the Control Center for a global-shell page. */
  external?: boolean;
}

const NAV_GROUPS = ['CONTROL', 'WORKFORCE', 'WAREHOUSE', 'FULFILLMENT', 'MONITORING', 'SYSTEM'] as const;

const NAV: NavEntry[] = [
  // CONTROL
  { to: '/admin', label: 'Overview', group: 'CONTROL', permission: 'operations.view' },
  { to: '/admin/operations', label: 'Operations', group: 'CONTROL', permission: 'operations.view' },

  // WORKFORCE
  { to: '/admin/workers', label: 'Workers', group: 'WORKFORCE', permission: 'operations.view' },
  { to: '/admin/stations', label: 'Stations', group: 'WORKFORCE', permission: 'stations.view' },
  { to: '/admin/devices', label: 'Devices', group: 'WORKFORCE', permission: 'stations.view' },
  { to: '/admin/tasks', label: 'Tasks', group: 'WORKFORCE', permission: 'operations.view' },

  // WAREHOUSE
  { to: '/warehouse/structure', label: 'Warehouse Tree', group: 'WAREHOUSE', permission: 'warehouses.view', external: true },
  { to: '/admin/receiving-containers', label: 'Receiving Containers', group: 'WAREHOUSE', permission: 'operations.view' },
  { to: '/categories', label: 'Categories', group: 'WAREHOUSE', permission: 'inventory.view', external: true },

  // FULFILLMENT
  { to: '/admin/orders', label: 'Orders', group: 'FULFILLMENT', permission: 'operations.view' },
  { to: '/admin/customer-bins', label: 'Customer Bins', group: 'FULFILLMENT', permission: 'operations.view' },
  { to: '/admin/shipments', label: 'Shipments', group: 'FULFILLMENT', permission: 'operations.view' },

  // MONITORING
  { to: '/admin/exceptions', label: 'Exceptions', group: 'MONITORING', permission: 'operations.view' },
  { to: '/admin/activity', label: 'Live Activity', group: 'MONITORING', permission: 'operations.view' },
  { to: '/admin/live', label: 'Live Wallboard', group: 'MONITORING', permission: 'operations.view' },
  { to: '/admin/traceability', label: 'Audit / Trace', group: 'MONITORING', permission: 'operations.view' },
  { to: '/admin/data-control', label: 'Data Control', group: 'MONITORING', permission: 'operations.view' },

  // SYSTEM
  { to: '/system', label: 'Settings', group: 'SYSTEM', permission: 'system.view', external: true },
];

function liveClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export default function AdminShell() {
  const { me, loading, logoutFn, hasPermission } = useAuth();
  const location = useLocation();

  // ONE overview poll per shell instance → header + pages share the payload.
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [pollLoading, setPollLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => liveClock());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const data = await adminApi.overview();
      setOverview(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Control center data unavailable.');
    } finally {
      setPollLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = window.setInterval(() => void reload(), 30_000); // bounded poll
    const c = window.setInterval(() => setNow(liveClock()), 1000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(c);
    };
  }, [reload]);

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  if (loading) {
    return (
      <div className="os-root theme-admin ac-boot">
        <div className="os-muted">loading control center…</div>
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;

  const visible = NAV.filter((n) => !n.permission || hasPermission(n.permission));
  const controlData: ControlData = {
    overview,
    loading: pollLoading,
    error,
    lastUpdated: overview?.generatedAt ?? null,
    reload,
  };

  const alerts = overview?.exceptions?.open ?? 0;
  const warehouse = overview?.warehouse ?? null;
  const warehouseOk = warehouse?.status === 'ACTIVE';
  const systemOk = overview?.system?.status === 'ONLINE';

  return (
    <div className="os-root theme-admin ac">
      {/* ---------------- HEADER ---------------- */}
      <header className="ac-top">
        <div className="ac-top-brand">
          <span className="ac-brand-main">AYROVI</span>
          <span className="ac-brand-slash">//</span>
          <span className="ac-brand-sub">WAREHOUSE CORE</span>
          <span className="ac-top-scope">CONTROL CENTER</span>
        </div>

        <div className="ac-top-strip">
          <span className="ac-top-item">
            <span className="ac-top-k">WAREHOUSE</span>
            <span className="mono">{warehouse?.code ?? '—'}</span>
          </span>
          <span className="ac-top-sep" aria-hidden />
          <span className="ac-top-item">
            <span className="ac-top-k">STATUS</span>
            {warehouse ? (
              warehouseOk
                ? <span className="os-tag os-tag--ok">● OPERATIONAL</span>
                : <span className="os-tag os-tag--warn">● {warehouse.status}</span>
            ) : (
              <span className="os-tag os-tag--muted">● UNKNOWN</span>
            )}
          </span>
          <span className="ac-top-sep" aria-hidden />
          <span className="ac-top-item">
            <span className="ac-top-k">SYSTEM</span>
            {systemOk
              ? <span className="os-tag os-tag--ok">ONLINE</span>
              : error
                ? <span className="os-tag os-tag--err">OFFLINE</span>
                : <span className="os-tag os-tag--muted">…</span>}
          </span>
          <span className="ac-top-sep" aria-hidden />
          <span className="ac-top-item">
            <span className="ac-top-k">ROLE</span>
            <span className="mono">{me.roles[0] ?? '—'}</span>
          </span>
          <span className="ac-top-sep" aria-hidden />
          <span className="ac-top-item">
            <span className="ac-top-k">ALERTS</span>
            {alerts > 0
              ? <span className="os-tag os-tag--err">{alerts} OPEN</span>
              : <span className="os-tag os-tag--ok">0</span>}
          </span>
        </div>

        <div className="ac-top-user" ref={menuRef}>
          <time className="ac-top-clock" dateTime={now}>{now}</time>
          <button
            type="button"
            className="ac-user-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={`${me.user.name} · ${me.roles.join(', ')}`}
          >
            <span className="ac-user-name">{me.user.name}</span>
            <span className="ac-user-sep">·</span>
            <span className="ac-user-role">{me.roles[0] ?? '—'}</span>
            <span className="ac-user-caret" aria-hidden>▾</span>
          </button>
          {menuOpen && (
            <div className="ac-menu" role="menu">
              <Link to="/profile" className="ac-menu-item" role="menuitem">Profile &amp; Permissions</Link>
              <button
                type="button"
                className="ac-menu-item ac-menu-item--danger"
                role="menuitem"
                onClick={() => void logoutFn()}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ---------------- BODY: SIDEBAR + MAIN ---------------- */}
      <div className="ac-body">
        <aside className="ac-side">
          <nav className="ac-nav">
            {NAV_GROUPS.map((g) => {
              const items = visible.filter((n) => n.group === g);
              if (items.length === 0) return null;
              return (
                <div key={g} className="ac-nav-group">
                  <div className="ac-nav-title">{g}</div>
                  {items.map((n) =>
                    n.external ? (
                      <Link key={n.to} to={n.to} className="ac-link ac-link--ext">
                        {n.label}
                        <span className="ac-link-arrow" aria-hidden>↗</span>
                      </Link>
                    ) : (
                      <NavLink
                        key={n.to}
                        to={n.to}
                        end={n.to === '/admin'}
                        className={({ isActive }) => `ac-link${isActive ? ' is-active' : ''}`}
                      >
                        {n.label}
                      </NavLink>
                    ),
                  )}
                </div>
              );
            })}
          </nav>
          <div className="ac-side-foot os-muted">
            {overview ? `updated ${new Date(overview.generatedAt).toLocaleTimeString()}` : '…'}
          </div>
        </aside>

        <main className="ac-main">
          <Outlet context={controlData} />
        </main>
      </div>
    </div>
  );
}
