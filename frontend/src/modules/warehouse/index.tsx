import { NavLink, Outlet } from 'react-router-dom';

/**
 * Warehouse module layout — groups the physical-structure screens under a
 * single `/warehouse/*` prefix with internal tabs and an <Outlet/>.
 */
const TABS = [
  { to: 'structure', label: 'Structure', perm: 'warehouses.view' },
  { to: 'warehouses', label: 'Warehouses', perm: 'warehouses.view' },
  { to: 'zones', label: 'Zones', perm: 'zones.view' },
  { to: 'aisles', label: 'Aisles', perm: 'aisles.view' },
  { to: 'racks', label: 'Racks', perm: 'racks.view' },
  { to: 'levels', label: 'Levels', perm: 'levels.view' },
  { to: 'locations', label: 'Locations', perm: 'locations.view' },
];

export default function WarehouseModule() {
  return (
    <div>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} style={({ isActive }) => ({
            padding: '6px 14px', borderRadius: 8, textDecoration: 'none',
            background: isActive ? 'var(--accent)' : 'transparent',
            color: isActive ? '#fff' : 'var(--text)',
            border: '1px solid var(--border)',
          })}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
