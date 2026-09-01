import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import GlobalShell from './components/GlobalShell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Profile from './pages/Profile';
import WarehouseModule from './modules/warehouse';
import StructureExplorer from './modules/warehouse/StructureExplorer';
import Warehouses from './modules/warehouse/Warehouses';
import Zones from './modules/warehouse/Zones';
import Aisles from './modules/warehouse/Aisles';
import Racks from './modules/warehouse/Racks';
import Levels from './modules/warehouse/Levels';
import Locations from './modules/warehouse/Locations';
import ExpectedArrivals from './modules/expected-arrivals/ExpectedArrivals';
const ReceivingTerminal = lazy(() => import('./modules/receiving-terminal/ReceivingTerminal'));
import Users from './pages/Users';
import Roles from './pages/Roles';
import Audit from './pages/Audit';
import System from './pages/System';
// WAREHOUSE OS — Worker Terminal pages (executed inside the Global Shell).
const WorkerShell = lazy(() => import('./terminal/WorkerShell'));
const WorkerTerminalHome = lazy(() => import('./terminal/WorkerTerminalHome'));
const ReceivingTask = lazy(() => import('./terminal/ReceivingTask'));
const PutawayTask = lazy(() => import('./terminal/PutawayTask'));
const ControlCenter = lazy(() => import('./admin/pages/ControlCenter'));
const AdminWorkers = lazy(() => import('./admin/pages/Workers'));
const AdminSessionDetail = lazy(() => import('./admin/pages/SessionDetail'));
const AdminStations = lazy(() => import('./admin/pages/Stations'));
const AdminExceptions = lazy(() => import('./admin/pages/Exceptions'));
const AdminCorrections = lazy(() => import('./admin/pages/Corrections'));

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
    // A floor worker must never be shown the admin dashboard, not even a
    // denial page for it (§2/§46). Send them back to their own workspace
    // instead; only users with no operational task see a message.
    const isWorker = me.permissions.includes('receiving.execute')
      || me.permissions.includes('stowing.execute');
    if (isWorker && !me.permissions.includes('operations.view')) {
      return <Navigate to="/terminal" replace />;
    }
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
        <Suspense fallback={<div className="login-wrap"><div className="spinner" style={{ color: 'var(--accent-2)' }} /></div>}>
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

          {/* ---- ONE GLOBAL SHELL (§12): header + nav + workspace for every
              role. Role-aware CONTENT, never role-specific layouts. -------- */}
          <Route element={<GlobalShell />}>
            <Route index element={<Dashboard />} />
            <Route path="profile" element={<Profile />} />

            {/* Worker Terminal pages inside the shell: identity/brand/logout
                come from the Global Shell; the task strip stays operational. */}
            <Route path="terminal" element={<WorkerShell />}>
              <Route index element={<WorkerTerminalHome />} />
              <Route
                path="receiving"
                element={<PermissionGate perm="receiving.execute"><ReceivingTask /></PermissionGate>}
              />
              <Route
                path="putaway"
                element={<PermissionGate perm="stowing.execute"><PutawayTask /></PermissionGate>}
              />
            </Route>

            {/* Admin Control Center PAGES (chrome comes from the Global Shell). */}
            <Route path="admin" element={<PermissionGate perm="operations.view"><ControlCenter /></PermissionGate>} />
            <Route path="admin/workers" element={<PermissionGate perm="operations.view"><AdminWorkers /></PermissionGate>} />
            <Route path="admin/workers/:id" element={<PermissionGate perm="operations.view"><AdminWorkers /></PermissionGate>} />
            <Route path="admin/sessions/:id" element={<PermissionGate perm="operations.view"><AdminSessionDetail /></PermissionGate>} />
            <Route path="admin/stations" element={<PermissionGate perm="stations.view"><AdminStations /></PermissionGate>} />
            <Route path="admin/exceptions" element={<PermissionGate perm="operations.view"><AdminExceptions /></PermissionGate>} />
            <Route path="admin/corrections" element={<PermissionGate perm="operations.view"><AdminCorrections /></PermissionGate>} />
            <Route path="admin/arrivals" element={<Navigate to="/expected-arrivals" replace />} />
            <Route path="admin/receiving" element={<Navigate to="/warehouse/receiving" replace />} />
            <Route path="admin/structure" element={<Navigate to="/warehouse/structure" replace />} />
            <Route path="admin/users" element={<Navigate to="/users" replace />} />
            <Route path="admin/roles" element={<Navigate to="/roles" replace />} />
            <Route path="admin/audit" element={<Navigate to="/audit" replace />} />
            <Route path="admin/system" element={<Navigate to="/system" replace />} />

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
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
