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
// WAREHOUSE OS — Worker Terminal (§3-§5) and Admin Control Center (§6).
import WorkerShell from './terminal/WorkerShell';
import WorkerTerminalHome from './terminal/WorkerTerminalHome';
import ReceivingTask from './terminal/ReceivingTask';
import AdminShell from './admin/AdminShell';
import ControlCenter from './admin/pages/ControlCenter';
import AdminWorkers from './admin/pages/Workers';
import AdminSessionDetail from './admin/pages/SessionDetail';
import AdminStations from './admin/pages/Stations';
import AdminExceptions from './admin/pages/Exceptions';
import AdminCorrections from './admin/pages/Corrections';

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

          {/* ---- WORKER TERMINAL (§3-§5) -------------------------------
              A worker's whole world. Full-screen, no admin navigation. */}
          <Route path="/terminal" element={<WorkerShell />}>
            <Route index element={<WorkerTerminalHome />} />
            <Route
              path="receiving"
              element={<PermissionGate perm="receiving.execute"><ReceivingTask /></PermissionGate>}
            />
          </Route>

          {/* ---- ADMIN CONTROL CENTER (§6/§36-§40) ---------------------
              Guarded by operations.view, which workers do not have (§41). */}
          <Route
            path="/admin"
            element={<PermissionGate perm="operations.view"><AdminShell /></PermissionGate>}
          >
            <Route index element={<ControlCenter />} />
            <Route path="workers" element={<AdminWorkers />} />
            <Route path="workers/:id" element={<AdminWorkers />} />
            <Route path="sessions/:id" element={<AdminSessionDetail />} />
            <Route path="stations" element={<AdminStations />} />
            <Route path="exceptions" element={<AdminExceptions />} />
            <Route path="corrections" element={<AdminCorrections />} />
            {/* Existing modules stay reachable from the Control Center nav. */}
            <Route path="arrivals" element={<Navigate to="/expected-arrivals" replace />} />
            <Route path="receiving" element={<Navigate to="/warehouse/receiving" replace />} />
            <Route path="structure" element={<Navigate to="/warehouse/structure" replace />} />
            <Route path="users" element={<Navigate to="/users" replace />} />
            <Route path="roles" element={<Navigate to="/roles" replace />} />
            <Route path="audit" element={<Navigate to="/audit" replace />} />
            <Route path="system" element={<Navigate to="/system" replace />} />
          </Route>
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
