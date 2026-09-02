import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { NAV_ITEMS } from '../components/NavItems';
import './global-shell.css';

/**
 * GLOBAL APPLICATION SHELL — the ONE shell every role uses.
 *
 * Architecture (UX spec):
 *   Global Header   -> AYROVI WAREHOUSE · live clock · compact identity
 *                      (name · primary role) + Account menu (Profile / Logout)
 *   Navigation      -> permission-filtered strip (RBAC-driven, not role-coded)
 *   Page Workspace  -> <Outlet /> (dashboards, operational workspaces, admin)
 *
 * Identity lives HERE and only here: pages never repeat the user card,
 * employee code, roles, logout or permission dumps. Operational workspaces
 * (receiving, putaway, admin control center) render full-bleed inside the
 * workspace area via `.gs-flush`.
 */
export default function GlobalShell() {
  const { me, loading, logoutFn, hasPermission } = useAuth();
  const [now, setNow] = useState(() => new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  // Close the account menu on navigation.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Close on outside click / Escape.
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
      <div className="login-wrap">
        <div className="spinner" style={{ color: 'var(--accent-2)' }} />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <div className="gs">
      <header className="gs-head">
        <div className="gs-brand">
          <span className="gs-brand-main">AYROVI</span>
          <span className="gs-brand-sub">WAREHOUSE</span>
        </div>

        <div className="gs-head-right">
          <time className="gs-clock" dateTime={now.toISOString()}>
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </time>

          <div className="gs-id" ref={menuRef}>
            <button
              type="button"
              className="gs-id-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title={`${me.user.name} · ${me.roles.join(', ')}`}
            >
              <span className="gs-id-name">{me.user.name}</span>
              <span className="gs-id-sep">·</span>
              <span className="gs-id-role">{me.roles[0] ?? '—'}</span>
              <span className="gs-id-caret" aria-hidden>▾</span>
            </button>

            {menuOpen && (
              <div className="gs-menu" role="menu">
                <NavLink to="/profile" className="gs-menu-item" role="menuitem">
                  Profile &amp; Permissions
                </NavLink>
                <button
                  type="button"
                  className="gs-menu-item gs-menu-item--danger"
                  role="menuitem"
                  onClick={() => void logoutFn()}
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="gs-nav" aria-label="Primary navigation">
        {visibleItems.map((item) => (
          <NavLink key={item.key} to={item.path} end={item.path === '/'} className="gs-nav-link">
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="gs-content" id="gs-content">
        <Outlet />
      </main>
    </div>
  );
}
