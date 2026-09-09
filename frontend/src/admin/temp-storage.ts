import client from '../api/client';

/**
 * Temporary Storage — ADMIN surface (Control Center extension).
 * Backend: /v1/temporary-storage/admin/* (ADMIN_WEB only).
 */

export interface TsAdminStationRow {
  station: { id: string; code: string; name: string; status: string };
  sections: string[];
  containers: number;
  stored: number;
  capacity: number;
  remaining: number;
  reviewItems: number;
}

export interface TsOverview {
  stations: TsAdminStationRow[];
  openMovesWaiting: number;
  reviewItems: Array<{
    id: string;
    sku: string | null;
    reference: string | null;
    productName: string | null;
    customerName: string | null;
    section: string | null;
    reason: string | null;
    scannedAt: string;
    scannedBy: string | null;
  }>;
  capacity: number;
}

export interface TsReportRow {
  id: string;
  stationCode: string;
  stationId: string;
  workerName: string;
  status: string;
  totals: {
    productsReceived: number;
    productsStored: number;
    productsInReview: number;
    containersUsed: number;
    exceptions: number;
  };
  finishedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  closedAt: string | null;
}

export interface TsReportDetail extends TsReportRow {
  deviceType: string | null;
  deviceName: string | null;
  observation: string | null;
  sectionsProcessed: string[];
  startedAt: string | null;
  submittedBy: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  closedBy: string | null;
}

export const tsAdminApi = {
  overview: () => client.get<TsOverview>('/v1/temporary-storage/admin/overview').then((r) => r.data),
  config: () => client.get<{ capacity: number }>('/v1/temporary-storage/admin/config').then((r) => r.data),
  setConfig: (capacity: number) =>
    client.put<{ capacity: number }>('/v1/temporary-storage/admin/config', { capacity }).then((r) => r.data),
  reports: (status?: string) =>
    client.get<TsReportRow[]>('/v1/temporary-storage/admin/reports', { params: status ? { status } : {} }).then((r) => r.data),
  report: (id: string) => client.get<TsReportDetail>(`/v1/temporary-storage/admin/reports/${id}`).then((r) => r.data),
  reviewReport: (id: string, note?: string) =>
    client.post<TsReportDetail>(`/v1/temporary-storage/admin/reports/${id}/review`, { note }).then((r) => r.data),
  closeReport: (id: string) =>
    client.post<TsReportDetail>(`/v1/temporary-storage/admin/reports/${id}/close`, {}).then((r) => r.data),
};
