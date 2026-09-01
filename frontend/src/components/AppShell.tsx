import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { NAV_ITEMS } from './NavItems';

/**
 * Application Shell shown after login:
 *   brand + user card, permission-aware navigation, logout, workspace.
 */
export default function AppShell() {
  const { me, loading, logoutFn, hasPermission } = useAuth();

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner" style={{ color: 'var(--accent-2)' }} />
      </div>
    );
  }

  // Not logged in -> redirect to login.
  if (!me) return <Navigate to="/login" replace />;

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  async function onLogout() {
    await logoutFn();
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="b1">AYROVI</div>
          <div className="b2">Warehouse</div>
        </div>
        <div className="brand-sub">Warehouse Core · Phase 0</div>

        <nav className="nav">
          <div className="section">Overview</div>
          {visibleItems.map((item) => (
            <NavLink key={item.key} to={item.path} end={item.path === '/'}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="user-card">
          <div className="u-name">{me.user.name}</div>
          <div className="u-code">Employee code: {me.user.employeeCode}</div>
          <div className="u-role">Role(s): {me.roles.join(', ')}</div>
          <button onClick={onLogout}>Log out</button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
