import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import WarehouseModule from './modules/warehouse';
import StructureExplorer from './modules/warehouse/StructureExplorer';
import Warehouses from './modules/warehouse/Warehouses';
import Zones from './modules/warehouse/Zones';
import Aisles from './modules/warehouse/Aisles';
import Racks from './modules/warehouse/Racks';
import Levels from './modules/warehouse/Levels';
import Locations from './modules/warehouse/Locations';
import ExpectedArrivals from './modules/expected-arrivals/ExpectedArrivals';
import ReceivingTerminal from './modules/receiving-terminal/ReceivingTerminal';
import Users from './pages/Users';
import Roles from './pages/Roles';
import Audit from './pages/Audit';
import System from './pages/System';

/** Guards a route by the required back-end permission; redirects otherwise. */
function PermissionGate({ perm, children }: { perm: string; children: JSX.Element }) {
  const { me, loading } = useAuth();
  // Wait for the session to resolve before deciding, so a hard refresh of a
  // guarded route (e.g. the full-screen Receiving Terminal) does not bounce
  // the user to /login while getMe() is still in flight.
  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner" style={{ color: 'var(--accent-2)' }} />
      </div>
    );
  }
  if (!me) return <Navigate to="/login" replace />;
  if (!me.permissions.includes(perm)) {
    return (
      <div className="main" style={{ padding: 40 }}>
        <h1 className="page-title">Access denied</h1>
        <p className="page-sub">You do not have permission to view this module.</p>
      </div>
    );
  }
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Receiving is a DEDICATED full-page operational route (worker
              workspace), so it lives OUTSIDE the dashboard shell to take over
              the viewport with no competing navigation. */}
          <Route
            path="/warehouse/receiving"
            element={<PermissionGate perm="receiving.view"><ReceivingTerminal /></PermissionGate>}
          />
          <Route path="/receiving" element={<Navigate to="/warehouse/receiving" replace />} />
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route
              path="expected-arrivals"
              element={<PermissionGate perm="expected_arrivals.view"><ExpectedArrivals /></PermissionGate>}
            />
            <Route path="warehouse" element={<PermissionGate perm="warehouses.view"><WarehouseModule /></PermissionGate>}>
              <Route index element={<Navigate to="structure" replace />} />
              <Route path="structure" element={<StructureExplorer />} />
              <Route path="warehouses" element={<Warehouses />} />
              <Route path="zones" element={<Zones />} />
              <Route path="aisles" element={<Aisles />} />
              <Route path="racks" element={<Racks />} />
              <Route path="levels" element={<Levels />} />
              <Route path="locations" element={<Locations />} />
            </Route>
            <Route path="users" element={<PermissionGate perm="users.view"><Users /></PermissionGate>} />
            <Route path="roles" element={<PermissionGate perm="roles.view"><Roles /></PermissionGate>} />
            <Route path="audit" element={<PermissionGate perm="audit.view"><Audit /></PermissionGate>} />
            <Route path="system" element={<PermissionGate perm="system.view"><System /></PermissionGate>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
