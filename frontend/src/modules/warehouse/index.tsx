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
      <nav className="tabs" aria-label="Warehouse structure sections">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `tab${isActive ? ' is-active' : ''}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
