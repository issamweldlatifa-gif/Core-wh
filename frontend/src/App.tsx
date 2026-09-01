import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
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
import { ErrorState, LoadingState } from './ui';
// WAREHOUSE OS — Worker Terminal and Admin Control Center. One design system,
// two experiences; there is no third legacy shell anymore.
const WorkerShell = lazy(() => import('./terminal/WorkerShell'));
const WorkerTerminalHome = lazy(() => import('./terminal/WorkerTerminalHome'));
const ReceivingTask = lazy(() => import('./terminal/ReceivingTask'));
const PutawayTask = lazy(() => import('./terminal/PutawayTask'));
const AdminShell = lazy(() => import('./admin/AdminShell'));
const ControlCenter = lazy(() => import('./admin/pages/ControlCenter'));
const AdminWorkers = lazy(() => import('./admin/pages/Workers'));
const AdminSessionDetail = lazy(() => import('./admin/pages/SessionDetail'));
const AdminStations = lazy(() => import('./admin/pages/Stations'));
const AdminExceptions = lazy(() => import('./admin/pages/Exceptions'));
const AdminCorrections = lazy(() => import('./admin/pages/Corrections'));

/** Full-screen neutral boot pane (used by top-level gates before a shell mounts). */
function BootPane({ dark = false }: { dark?: boolean }) {
  return (
    <div className={dark ? 'boot-pane boot-pane--dark' : 'boot-pane'}>
      <span className="os-spinner" />
    </div>
  );
}

/**
 * Entry routing after login. A floor worker must land in THEIR world, never
 * in an admin dashboard (§18): LOGIN → WORKER TERMINAL → TASK. Everyone
 * else lands in the Admin Control Center.
 */
function RootRedirect() {
  const { me, loading } = useAuth();
  if (loading) return <BootPane dark />;
  if (!me) return <Navigate to="/login" replace />;
  const isWorker = me.permissions.includes('receiving.execute')
    || me.permissions.includes('stowing.execute');
  const seesOperations = me.permissions.includes('operations.view');
  if (isWorker && !seesOperations) return <Navigate to="/terminal" replace />;
  return <Navigate to="/admin" replace />;
}

/** Guards a route by the required back-end permission; redirects otherwise. */
function PermissionGate({ perm, children }: { perm: string; children: JSX.Element }) {
  const { me, loading } = useAuth();
  // Wait for the session to resolve before deciding, so a hard refresh of a
  // guarded route (e.g. the full-screen Receiving Terminal) does not bounce
  // the user to /login while getMe() is still in flight.
  if (loading) return <LoadingState block label="Checking permissions…" />;
  if (!me) return <Navigate to="/login" replace />;
  if (!me.permissions.includes(perm)) {
    // A floor worker must never be shown the admin dashboard, not even a
    // denial page for it. Send them back to their own workspace instead;
    // only users with no operational task see a message.
    const isWorker = me.permissions.includes('receiving.execute')
      || me.permissions.includes('stowing.execute');
    if (isWorker && !me.permissions.includes('operations.view')) {
      return <Navigate to="/terminal" replace />;
    }
    return (
      <ErrorState
        kind="warning"
        title="Access denied"
        detail={`Your account does not have the “${perm}” permission. Ask an administrator if you need access to this module.`}
      />
    );
  }
  return children;
}

/**
 * /admin index: the Control Center for operations staff; everyone else is
 * routed to the first module their permissions actually allow.
 */
function AdminIndex() {
  const { me } = useAuth();
  if (!me) return <Navigate to="/login" replace />;
  if (me.permissions.includes('operations.view')) return <ControlCenter />;
  const firstAllowed = [
    { perm: 'expected_arrivals.view', to: '/expected-arrivals' },
    { perm: 'warehouses.view', to: '/warehouse/structure' },
    { perm: 'users.view', to: '/users' },
    { perm: 'roles.view', to: '/roles' },
    { perm: 'audit.view', to: '/audit' },
    { perm: 'system.view', to: '/system' },
    { perm: 'receiving.view', to: '/warehouse/receiving' },
  ].find((m) => me.permissions.includes(m.perm));
  if (firstAllowed) return <Navigate to={firstAllowed.to} replace />;
  return (
    <ErrorState
      kind="info"
      title="No modules available"
      detail="Your account has no module permissions yet. Ask an administrator to assign you a role."
    />
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<BootPane dark />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RootRedirect />} />

          {/* Receiving is a DEDICATED full-page operational route (worker
              workspace), so it lives OUTSIDE the admin shell to take over
              the viewport with no competing navigation. */}
          <Route
            path="/warehouse/receiving"
            element={<PermissionGate perm="receiving.view"><ReceivingTerminal /></PermissionGate>}
          />
          <Route path="/receiving" element={<Navigate to="/warehouse/receiving" replace />} />

          {/* ---- WORKER TERMINAL ------------------------------------------
              A worker's whole world. Full-screen, no admin navigation. */}
          <Route path="/terminal" element={<WorkerShell />}>
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

          {/* ---- ADMIN CONTROL CENTER + MANAGEMENT MODULES ----------------
              One shell, one design language. Module routes keep their
              historical URLs and keep their own permission gates. */}
          <Route element={<AdminShell />}>
            <Route path="/admin">
              <Route index element={<AdminIndex />} />
              <Route path="workers" element={<AdminWorkers />} />
              <Route path="workers/:id" element={<AdminWorkers />} />
              <Route path="sessions/:id" element={<AdminSessionDetail />} />
              <Route path="stations" element={<AdminStations />} />
              <Route path="exceptions" element={<AdminExceptions />} />
              <Route path="corrections" element={<AdminCorrections />} />
              {/* Convenience links from the Control Center nav. */}
              <Route path="arrivals" element={<Navigate to="/expected-arrivals" replace />} />
              <Route path="receiving" element={<Navigate to="/warehouse/receiving" replace />} />
              <Route path="structure" element={<Navigate to="/warehouse/structure" replace />} />
              <Route path="users" element={<Navigate to="/users" replace />} />
              <Route path="roles" element={<Navigate to="/roles" replace />} />
              <Route path="audit" element={<Navigate to="/audit" replace />} />
              <Route path="system" element={<Navigate to="/system" replace />} />
            </Route>

            <Route
              path="expected-arrivals"
              element={<PermissionGate perm="expected_arrivals.view"><ExpectedArrivals /></PermissionGate>}
            />
            <Route
              path="warehouse"
              element={<PermissionGate perm="warehouses.view"><WarehouseModule /></PermissionGate>}
            >
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
