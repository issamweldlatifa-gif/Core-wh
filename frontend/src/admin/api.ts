import client from '../api/client';

/** Admin Control Center API surface (§6/§36-§40). */

export interface MetricCell {
  key: 'active' | 'waiting' | 'attention' | 'ready' | 'blocked' | 'done' | 'exceptions' | 'info';
  value: number;
  unit: string;
}

export interface PipelineStage {
  id: string;
  title: string;
  cells: MetricCell[];
}

export interface OperationRow {
  id: string;
  title: string;
  status: { label: string; tone: 'ok' | 'warn' | 'muted' };
  current: number;
  attention: number;
  cells: MetricCell[];
  open: string | null;
}

export interface ActivityEvent {
  id: string;
  at: string;
  action: string;
  entityType: string | null;
  entity: string | null;
  worker: { id: string; name: string; employeeCode: string } | null;
}

export interface ExceptionRowLight {
  id: string;
  type: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  status: string;
  reason: string | null;
  expectedQuantity: number | null;
  actualQuantity: number | null;
  difference: number | null;
  createdAt: string;
  session: { id: string; code: string; arrival: { code: string; customerName: string } | null } | null;
  worker: { id: string; name: string; employeeCode: string } | null;
}

export interface WorkerLiveRow {
  id: string;
  name: string;
  employeeCode: string;
  status: string;
  roles: string[];
  station: { id: string; code: string; name: string; department: string } | null;
  activeTask: { kind: 'RECEIVING' | 'PUTAWAY'; code: string; startedAt: string } | null;
  lastActivityAt: string | null;
}

export interface OpsOverview {
  generatedAt: string;
  warehouse: { id: string; code: string; name: string; status: string } | null;
  system: { status: 'ONLINE' };
  counters: {
    activeSessions: number;
    todaySessions: number;
    openExceptions: number;
    expectedArrivals: number;
    cartonsReceivedToday: number;
    correctionsToday: number;
    activeStations: number;
    stations: number;
    activePutawaySessions: number;
    cartonsStoredToday: number;
    awaitingPutaway: number;
    openOrders: number;
    articlesAwaitingSorting: number;
    articlesStored: number;
    binsReadyForPacking: number;
    shipmentsReadyToShip: number;
    shippedToday: number;
    piecesStoredToday: number;
    articlesInCustomerBins: number;
    articlesAwaitingOrder: number;
    activeReceivingContainers: number;
    articlesInOperation: number;
  };
  pipeline: PipelineStage[];
  operations: OperationRow[];
  workers: WorkerLiveRow[];
  /** Receiving Containers/Totes board (top rows, real data). */
  receivingContainers: ContainerBoardRow[];
  /** Customer Bins board (top rows, real data). */
  customerBins: ContainerBoardRow[];
  exceptions: {
    open: number;
    bySeverity: Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', number>;
    recent: ExceptionRowLight[];
  };
  activity: ActivityEvent[];
  stations: Array<{
    id: string; code: string; name: string; department: string; status: string;
    capabilities: string[];
    worker: { id: string; name: string; employeeCode: string } | null;
    workerTask: string | null;
  }>;
  activeSessions: Array<{
    id: string; code: string; status: string; startedAt: string;
    arrival: { id: string; code: string; customerName: string; storeName: string | null } | null;
    stationCode: string | null;
    worker: { id: string; name?: string; employeeCode?: string } | null;
    cartonEvents: number; discrepancies: number;
  }>;
  putawaySessions: Array<{
    id: string; code: string; status: string; startedAt: string;
    worker: { id: string; name: string; employeeCode: string } | null;
    stationCode: string | null;
    placements: number;
  }>;
}

export interface WorkerRow {
  id: string; name: string; employeeCode: string; status: string;
  roles: string[];
  station: { id: string; code: string; name: string; department: string } | null;
  sessionsToday: number;
  activeTask?: { kind: 'RECEIVING' | 'PUTAWAY'; code: string; startedAt: string } | null;
  lastActivityAt?: string | null;
}

export interface WorkerDetail {
  worker: WorkerRow;
  sessions: Array<{
    id: string; code: string; status: string; startedAt: string; completedAt: string | null;
    arrival: { id: string; code: string; customerName: string } | null;
    counts: { cartons: number; products: number; discrepancies: number };
  }>;
  /** Stowing history — a worker is more than their receiving sessions. */
  putawaySessions: Array<{
    id: string; code: string; status: string;
    startedAt: string; completedAt: string | null;
    stationCode: string | null;
    placements: number;
  }>;
}

export interface SessionDetail {
  session: {
    id: string; code: string; status: string; startedAt: string; completedAt: string | null;
    deviceType: string | null;
    arrival: any; shipment: any;
    /** Station the session was executed at (§13). */
    station: { id: string; code: string; name: string; department: string } | null;
    worker: { id: string; name: string; employeeCode: string } | null;
  };
  cartons: Array<{
    id: string; scannedCode: string; status: string; source: string; scanType: string;
    receivedAt: string | null;
  }>;
  products: Array<{
    id: string; sku: string | null; productName: string | null;
    expectedQuantity: number; receivedQuantity: number; status: string;
  }>;
  discrepancies: Array<{ id: string; type: string; status: string; reason: string | null }>;
  corrections: Array<{
    id: string; code: string; action: string; reason: string; createdAt: string;
    admin: { id: string; name: string } | null;
    originalSnapshot: unknown; newSnapshot: unknown;
  }>;
  timeline: Array<{ at: string; kind: string; label: string; detail: Record<string, unknown> }>;
}

export interface ExceptionRow {
  id: string; type: string; severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  status: string; reason: string | null;
  expectedQuantity: number | null; actualQuantity: number | null; difference: number | null;
  createdAt: string; resolvedAt: string | null; resolution: string | null;
  session: { id: string; code: string; arrival: { code: string; customerName: string } | null } | null;
  worker: { id: string; name: string; employeeCode: string } | null;
}

export interface CorrectionRow {
  id: string; code: string; action: string; reason: string; createdAt: string;
  entityType: string; entityId: string;
  admin: { id: string; name: string; employeeCode: string } | null;
  worker: { id: string; name: string } | null;
  session: { id: string; code: string } | null;
  originalSnapshot: unknown; newSnapshot: unknown;
}

export interface StationRow {
  id: string; code: string; name: string; department: string; status: string;
  capabilities: string[]; deviceId: string | null;
  assignedWorker: { id: string; name: string; employeeCode: string } | null;
}

export interface TaskRow {
  key: string; label: string; path: string; department: string;
  permission: string; ready: boolean;
  executors: number;
  stations: number; activeStations: number;
  open: number | null;
}

export interface ContainerRow {
  id: string; code: string; type: 'RECEIVING' | 'CUSTOMER'; status: string;
  label: string | null;
  order: { externalOrderReference: string; externalCustomerReference: string } | null;
  _count: { articles: number };
  createdAt: string; updatedAt: string;
}

/** Receiving Container / Tote or Customer Bin as a first-class operational
 *  object (COMMAND #1 FINAL §08/§12). FULL is derived server-side from the
 *  configurable capacity. Worker/station derive from real provenance. */
export interface ContainerBoardRow {
  id: string;
  code: string;
  type: 'RECEIVING' | 'CUSTOMER';
  /** Display status (FULL when a tote reached capacity, else dbStatus). */
  status: string;
  dbStatus: string;
  capacity: number;
  count: number;
  fill: number | null;
  label: string | null;
  order: { id: string; reference: string; customer: string } | null;
  /** Customer bins only: units requested on the linked order. */
  expected: number | null;
  worker: { id: string; name: string; employeeCode: string } | null;
  station: { id: string; code: string; name: string } | null;
  createdAt: string;
  lastActivity: string | null;
}

export interface ContainerDetail {
  container: {
    id: string; code: string; type: 'RECEIVING' | 'CUSTOMER';
    status: string; dbStatus: string;
    capacity: number; count: number; fill: number | null;
    label: string | null;
    order: { reference: string; customer: string; status: string; note: string | null } | null;
    worker: { id: string; name: string; employeeCode: string } | null;
    sortingWorker: { id: string; name: string; employeeCode: string } | null;
    station: { id: string; code: string; name: string } | null;
    createdAt: string;
    closedAt: string | null;
    lastActivity: string;
  };
  articles: Array<{
    id: string; code: string; sku: string; productName: string | null;
    category: string | null; subcategory: string | null; categoryStatus: string;
    status: string;
    sourceCarton: { code: string; qr: string | null } | null;
    receivingSession: {
      id: string; code: string; status: string; startedAt: string; completedAt: string | null;
    } | null;
    order: { id: string; reference: string; customer: string } | null;
    currentLocation: { locationCode: string } | null;
    outboundShipment: { code: string; status: string } | null;
    createdAt: string;
  }>;
}

export const adminApi = {
  overview: () => client.get<OpsOverview>('/v1/operations/overview').then((r) => r.data),
  activity: (limit = 60) =>
    client.get<ActivityEvent[]>('/v1/operations/activity', { params: { limit } }).then((r) => r.data),
  tasks: () => client.get<TaskRow[]>('/v1/operations/tasks').then((r) => r.data),
  workers: () => client.get<WorkerRow[]>('/v1/operations/workers').then((r) => r.data),
  worker: (id: string) => client.get<WorkerDetail>(`/v1/operations/workers/${id}`).then((r) => r.data),
  session: (id: string) => client.get<SessionDetail>(`/v1/operations/sessions/${id}`).then((r) => r.data),
  exceptions: (status = 'OPEN') =>
    client.get<ExceptionRow[]>('/v1/operations/exceptions', { params: { status } }).then((r) => r.data),
  corrections: (sessionId?: string) =>
    client.get<CorrectionRow[]>('/v1/operations/corrections', { params: { sessionId } }).then((r) => r.data),

  stations: () => client.get<StationRow[]>('/v1/stations').then((r) => r.data),
  createStation: (d: { code: string; name: string; department: string; capabilities?: string[] }) =>
    client.post<StationRow>('/v1/stations', d).then((r) => r.data),
  stationStatus: (id: string, status: string) =>
    client.post<StationRow>(`/v1/stations/${id}/status`, { status }).then((r) => r.data),
  assignStation: (id: string, workerId: string | null) =>
    client.post<StationRow>(`/v1/stations/${id}/assign`, { workerId }).then((r) => r.data),

  // Operational containers (COMMAND #1 FINAL §08/§12).
  receivingContainers: () =>
    client.get<ContainerBoardRow[]>('/v1/operations/receiving-containers').then((r) => r.data),
  customerBins: () =>
    client.get<ContainerBoardRow[]>('/v1/operations/customer-bins').then((r) => r.data),
  container: (code: string) =>
    client.get<ContainerDetail>(`/v1/operations/containers/${encodeURIComponent(code)}`).then((r) => r.data),
  containers: (params?: { type?: string; status?: string }) =>
    client.get<ContainerRow[]>('/v1/fulfillment/containers', { params }).then((r) => r.data),

  // Corrections — every one carries a mandatory reason (§39).
  reverseCarton: (receivingCartonId: string, reason: string) =>
    client.post('/v1/operations/corrections/reverse-carton', { receivingCartonId, reason }).then((r) => r.data),
  correctQuantity: (receivingProductId: string, newQuantity: number, reason: string) =>
    client.post('/v1/operations/corrections/correct-quantity', { receivingProductId, newQuantity, reason }).then((r) => r.data),
  resolveException: (discrepancyId: string, reason: string, resolution?: string) =>
    client.post('/v1/operations/corrections/resolve-exception', { discrepancyId, reason, resolution }).then((r) => r.data),
  reopenSession: (sessionId: string, reason: string) =>
    client.post('/v1/operations/corrections/reopen-session', { sessionId, reason }).then((r) => r.data),

  // Admin Data Control — soft-void (COMMAND #2). Read = operations.view,
  // void = operations.correct (admin only).
  dataControlSearch: (q: string) =>
    client.get<DataControlHit[]>('/v1/operations/data-control/search', { params: { q } }).then((r) => r.data),
  dataControlVoided: () =>
    client.get<DataControlVoidedRow[]>('/v1/operations/data-control/voided').then((r) => r.data),
  dataControlVoid: (kind: DataControlKind, code: string, reason?: string, id?: string) =>
    client.post<DataControlVoidResult>('/v1/operations/data-control/void', { kind, code, reason, id }).then((r) => r.data),
};

export type DataControlKind = 'arrival' | 'order' | 'container' | 'article' | 'carton';

export interface DataControlHit {
  /** Stable primary key — used to void exactly one record when several
   * records share the same scanned code (duplicate scans). */
  id: string;
  kind: DataControlKind;
  code: string;
  label: string;
  status: string;
  createdAt: string;
}

export interface DataControlCascade {
  kind: string;
  code: string;
}

export interface DataControlVoidResult {
  ok: true;
  kind: DataControlKind;
  code: string;
  previousStatus: string;
  status: string;
  cascaded: DataControlCascade[];
}

export interface DataControlVoidedRow {
  id: string;
  at: string;
  kind: string | null;
  code: string | null;
  reason: string | null;
  previousStatus: string | null;
  cascaded: unknown;
  admin: { id: string; name: string; employeeCode: string } | null;
}
