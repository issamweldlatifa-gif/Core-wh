import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * GLOBAL APPLICATION SHELL — the ONE shell every role uses.
 *
 * Architecture (§ ONE GLOBAL SHELL + ROLE-AWARE CONTENT):
 *   Global Header  -> AYROVI WAREHOUSE · live clock · "Name · ROLE" · account menu
 *   Navigation     -> single permission-aware strip (same shell, different items)
 *   Page Workspace -> <Outlet /> (Dashboard monitors; workspaces execute)
 *
 * Identity appears exactly ONCE, here. Logout lives ONLY in the account menu.
 * Effective permissions live ONLY on /profile. No page may repeat them.
 */

interface NavEntry {
  to: string;
  label: string;
  /** Any listed permission makes the item visible (permission-aware nav). */
  anyOf?: string[];
  sepBefore?: boolean;
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/terminal', label: 'My Tasks', anyOf: ['receiving.execute', 'stowing.execute'] },
  { to: '/admin', label: 'Control Center', anyOf: ['operations.view'], sepBefore: true },
  { to: '/admin/workers', label: 'Workers', anyOf: ['operations.view'] },
  { to: '/admin/stations', label: 'Stations', anyOf: ['stations.view'] },
  { to: '/admin/exceptions', label: 'Exceptions', anyOf: ['operations.view'] },
  { to: '/admin/corrections', label: 'Corrections', anyOf: ['operations.view'] },
  { to: '/expected-arrivals', label: 'Arrivals', anyOf: ['expected_arrivals.view'], sepBefore: true },
  { to: '/warehouse/receiving', label: 'Receiving', anyOf: ['receiving.view'] },
  { to: '/warehouse/structure', label: 'Warehouse', anyOf: ['warehouses.view'] },
  { to: '/users', label: 'Users', anyOf: ['users.view'], sepBefore: true },
  { to: '/roles', label: 'Roles', anyOf: ['roles.view'] },
  { to: '/audit', label: 'Audit', anyOf: ['audit.view'] },
  { to: '/system', label: 'System', anyOf: ['system.view'] },
];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 5_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export default function GlobalShell() {
  const { me, loading, logoutFn, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useClock();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the account menu whenever the workspace changes underneath it.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Click-outside closes the account menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner" style={{ color: 'var(--terminal-green)' }} />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;

  const visible = NAV.filter((n) => !n.anyOf || n.anyOf.some((p) => hasPermission(p)));
  const primaryRole = me.roles[0] ?? '—';
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="gs os-root theme-admin">
      {/* ---- GLOBAL HEADER: brand · clock · identity · account (§1/§2) ---- */}
      <header className="gs-header">
        <div className="gs-brand">
          <span className="gs-brand-a">AYROVI</span>{' '}
          <span className="gs-brand-w">WAREHOUSE</span>
        </div>

        <span className="gs-clock" title={now.toLocaleDateString()}>{time}</span>

        <span className="gs-id" title={`${me.user.name} · ${me.roles.join(', ')}`}>
          <span className="gs-id-name">{me.user.name}</span>
          <span className="gs-id-sep">·</span>
          <span className="gs-id-role">{primaryRole}</span>
        </span>

        <div className="gs-account" ref={menuRef}>
          <button
            type="button"
            className={`gs-account-btn${menuOpen ? ' gs-open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            title="Account"
          >
            ▼
          </button>
          {menuOpen && (
            <div className="gs-menu" role="menu">
              <div className="gs-menu-head">
                <div className="gs-menu-name">{me.user.name}</div>
                <div className="gs-menu-code">{me.user.employeeCode} · {me.roles.join(', ')}</div>
              </div>
              <button
                type="button"
                className="gs-menu-item"
                role="menuitem"
                onClick={() => navigate('/profile')}
              >
                Profile &amp; Permissions
              </button>
              <button
                type="button"
                className="gs-menu-item gs-menu-logout"
                role="menuitem"
                onClick={() => void logoutFn()}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ---- GLOBAL NAVIGATION: same shell, permission-aware items (§12) ---- */}
      <nav className="gs-nav" aria-label="Main navigation">
        {visible.map((n) => (
          <span key={n.to} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {n.sepBefore && <span className="gs-nav-sep">|</span>}
            <NavLink to={n.to} end={n.to === '/' || n.to === '/admin' || n.to === '/terminal'}>
              {n.label}
            </NavLink>
          </span>
        ))}
      </nav>

      {/* ---- PAGE WORKSPACE (Dashboard = monitor; workspaces = execute) ---- */}
      <main className="gs-main">
        <Outlet />
      </main>
    </div>
  );
}
