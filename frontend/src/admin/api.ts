import client from '../api/client';

/** Admin Control Center API surface (§6/§36-§40). */

export interface OpsOverview {
  generatedAt: string;
  counters: {
    activeSessions: number;
    todaySessions: number;
    openExceptions: number;
    expectedArrivals: number;
    cartonsReceivedToday: number;
    correctionsToday: number;
    activeStations: number;
    stations: number;
  };
  stations: Array<{
    id: string; code: string; name: string; department: string; status: string;
    capabilities: string[];
    worker: { id: string; name: string; employeeCode: string } | null;
  }>;
  activeSessions: Array<{
    id: string; code: string; status: string; startedAt: string;
    arrival: { id: string; code: string; customerName: string; storeName: string | null } | null;
    worker: { id: string; name?: string; employeeCode?: string } | null;
    cartonEvents: number; discrepancies: number;
  }>;
}

export interface WorkerRow {
  id: string; name: string; employeeCode: string; status: string;
  roles: string[];
  station: { id: string; code: string; name: string; department: string } | null;
  sessionsToday: number;
}

export interface WorkerDetail {
  worker: WorkerRow;
  sessions: Array<{
    id: string; code: string; status: string; startedAt: string; completedAt: string | null;
    arrival: { id: string; code: string; customerName: string } | null;
    counts: { cartons: number; products: number; discrepancies: number };
  }>;
}

export interface SessionDetail {
  session: {
    id: string; code: string; status: string; startedAt: string; completedAt: string | null;
    deviceType: string | null;
    arrival: any; shipment: any;
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
  id: string; type: string; status: string; reason: string | null;
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

export const adminApi = {
  overview: () => client.get<OpsOverview>('/v1/operations/overview').then((r) => r.data),
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

  // Corrections — every one carries a mandatory reason (§39).
  reverseCarton: (receivingCartonId: string, reason: string) =>
    client.post('/v1/operations/corrections/reverse-carton', { receivingCartonId, reason }).then((r) => r.data),
  correctQuantity: (receivingProductId: string, newQuantity: number, reason: string) =>
    client.post('/v1/operations/corrections/correct-quantity', { receivingProductId, newQuantity, reason }).then((r) => r.data),
  resolveException: (discrepancyId: string, reason: string, resolution?: string) =>
    client.post('/v1/operations/corrections/resolve-exception', { discrepancyId, reason, resolution }).then((r) => r.data),
  reopenSession: (sessionId: string, reason: string) =>
    client.post('/v1/operations/corrections/reopen-session', { sessionId, reason }).then((r) => r.data),
};
