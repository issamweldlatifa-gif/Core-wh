import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import GlobalShell from './shell/GlobalShell';
import Login from './pages/Login';
import Profile from './pages/Profile';
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
import Users from './pages/Users';
import Roles from './pages/Roles';
import Audit from './pages/Audit';
import System from './pages/System';
// WAREHOUSE OS — Worker Terminal (§3-§5) and Admin Control Center (§6).
const WorkerShell = lazy(() => import('./terminal/WorkerShell'));
const WorkerTerminalHome = lazy(() => import('./terminal/WorkerTerminalHome'));
const ReceivingTask = lazy(() => import('./terminal/ReceivingTask'));
const PutawayTask = lazy(() => import('./terminal/PutawayTask'));
const SortingTask = lazy(() => import('./terminal/SortingTask'));
const OrderSortingTask = lazy(() => import('./terminal/OrderSortingTask'));
const PackingTask = lazy(() => import('./terminal/PackingTask'));
const ShippingTask = lazy(() => import('./terminal/ShippingTask'));
const AdminShell = lazy(() => import('./admin/AdminShell'));
const ControlCenter = lazy(() => import('./admin/pages/ControlCenter'));
const AdminWorkers = lazy(() => import('./admin/pages/Workers'));
const AdminSessionDetail = lazy(() => import('./admin/pages/SessionDetail'));
const AdminStations = lazy(() => import('./admin/pages/Stations'));
const AdminExceptions = lazy(() => import('./admin/pages/Exceptions'));
const AdminCorrections = lazy(() => import('./admin/pages/Corrections'));
const AdminTraceability = lazy(() => import('./admin/pages/Traceability'));
const AdminOrders = lazy(() => import('./admin/pages/Orders'));
const AdminOutboundShipments = lazy(() => import('./admin/pages/OutboundShipments'));
// Admin Control Center V1 pages.
const AdminOperations = lazy(() => import('./admin/pages/Operations'));
const AdminLiveActivity = lazy(() => import('./admin/pages/LiveActivity'));
const AdminContainers = lazy(() => import('./admin/pages/Containers'));
const AdminTasks = lazy(() => import('./admin/pages/Tasks'));
const Categories = lazy(() => import('./modules/categories/Categories'));

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
      <div style={{ padding: 40, maxWidth: 720, margin: '0 auto' }}>
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
          {/* RECEIVING CONSOLIDATION — ONE canonical route: /terminal/receiving
              (the worker-terminal workspace). Every legacy path redirects there,
              so no entry point can ever reach the old terminal UI again. */}
          <Route path="/warehouse/receiving" element={<Navigate to="/terminal/receiving" replace />} />
          <Route path="/receiving" element={<Navigate to="/terminal/receiving" replace />} />

          {/* ---- GLOBAL APPLICATION SHELL ------------------------------
              ONE shell for every role: global header (brand + clock +
              compact identity + account menu), permission-filtered nav,
              page workspace. Workers, admins and auditors all land here;
              only the content and nav items differ (RBAC-driven). */}
          <Route element={<GlobalShell />}>
            <Route index element={<Dashboard />} />
            <Route path="/profile" element={<Profile />} />
          {/* ---- WORKER TERMINAL (§3-§5) -------------------------------
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
            <Route
              path="sorting"
              element={<PermissionGate perm="stowing.execute"><SortingTask /></PermissionGate>}
            />
            <Route
              path="order-sorting"
              element={<PermissionGate perm="picking.execute"><OrderSortingTask /></PermissionGate>}
            />
            <Route
              path="packing"
              element={<PermissionGate perm="packing.execute"><PackingTask /></PermissionGate>}
            />
            <Route
              path="shipping"
              element={<PermissionGate perm="shipping.execute"><ShippingTask /></PermissionGate>}
            />
          </Route>

          {/* ---- ADMIN CONTROL CENTER (§6/§36-§40) ---------------------
              Guarded by operations.view, which workers do not have (§41). */}
          <Route
            path="/admin"
            element={<PermissionGate perm="operations.view"><AdminShell /></PermissionGate>}
          >
            <Route index element={<ControlCenter />} />
            <Route path="operations" element={<AdminOperations />} />
            <Route path="activity" element={<AdminLiveActivity />} />
            <Route path="containers" element={<AdminContainers />} />
            <Route path="tasks" element={<AdminTasks />} />
            <Route path="workers" element={<AdminWorkers />} />
            <Route path="workers/:id" element={<AdminWorkers />} />
            <Route path="sessions/:id" element={<AdminSessionDetail />} />
            <Route path="stations" element={<AdminStations />} />
            <Route path="exceptions" element={<AdminExceptions />} />
            <Route path="corrections" element={<AdminCorrections />} />
            <Route path="traceability" element={<AdminTraceability />} />
            <Route path="orders" element={<AdminOrders />} />
            <Route path="shipments" element={<AdminOutboundShipments />} />
            {/* Existing modules stay reachable from the Control Center nav. */}
            <Route path="arrivals" element={<Navigate to="/expected-arrivals" replace />} />
            <Route path="receiving" element={<Navigate to="/terminal/receiving" replace />} />
            <Route path="structure" element={<Navigate to="/warehouse/structure" replace />} />
            <Route path="categories" element={<Navigate to="/categories" replace />} />
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
              path="categories"
              element={<PermissionGate perm="inventory.view"><Categories /></PermissionGate>}
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
