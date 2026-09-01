import client from '../api/client';
import type { ScanSource } from '../modules/receiving-terminal/scan-source';

/** Typed client for the Putaway (stowing) terminal API. */

export interface QueueCarton {
  id: string;
  externalCartonId: string;
  cartonNumber: number;
  totalCartons: number;
  receivedAt: string | null;
  shipmentCode: string | null;
  arrivalCode: string | null;
  customerName: string | null;
}

export interface PutawayPlacement {
  id: string;
  cartonCode: string;
  locationCode: string;
  placedAt: string;
  releasedAt: string | null;
  cartonSource: string;
  locationSource: string;
}

export interface PutawaySession {
  id: string;
  code: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';
  startedAt: string;
  completedAt: string | null;
  worker: { id: string; name: string; employeeCode: string } | null;
  station: { id: string; code: string; name: string } | null;
  placements: PutawayPlacement[];
  tally: {
    storedThisSession: number;
    totalPlacements: number;
    pendingCartons: number;
  };
}

/** Mirrors the backend `PutawayFlash` union. */
export type PutawayFlash =
  | { kind: 'CARTON_READY'; carton: {
      id: string; externalCartonId: string; status: string;
      currentLocation: string | null; arrivalCode: string | null; customerName: string | null;
    } }
  | { kind: 'LOCATION_READY'; location: {
      id: string; locationCode: string; locationType: string; status: string;
    } }
  | { kind: 'STORED'; carton: { externalCartonId: string; status: string };
      location: { locationCode: string }; moved: boolean }
  | { kind: 'UNKNOWN_CARTON'; code: string }
  | { kind: 'UNKNOWN_LOCATION'; code: string }
  | { kind: 'CARTON_NOT_RECEIVED'; code: string; status: string }
  | { kind: 'LOCATION_UNAVAILABLE'; code: string; status: string };

export const putawayApi = {
  queue: () =>
    client.get<QueueCarton[]>('/v1/putaway/queue').then((r) => r.data),

  active: () =>
    client.get<PutawaySession | null>('/v1/putaway/sessions/active').then((r) => r.data),

  session: (id: string) =>
    client.get<PutawaySession>(`/v1/putaway/sessions/${id}`).then((r) => r.data),

  start: (body: { deviceType?: string; deviceName?: string }) =>
    client.post<PutawaySession>('/v1/putaway/sessions/start', body).then((r) => r.data),

  scanCarton: (code: string) =>
    client.post<{ flash: PutawayFlash }>('/v1/putaway/scan-carton', { code }).then((r) => r.data.flash),

  scanLocation: (code: string) =>
    client.post<{ flash: PutawayFlash }>('/v1/putaway/scan-location', { code }).then((r) => r.data.flash),

  place: (
    sessionId: string,
    body: {
      cartonCode: string; locationCode: string;
      cartonSource?: ScanSource; locationSource?: ScanSource;
    },
  ) =>
    client
      .post<{ flash: PutawayFlash; session?: PutawaySession }>(
        `/v1/putaway/sessions/${sessionId}/place`, body,
      )
      .then((r) => r.data),

  pause: (id: string) =>
    client.post<PutawaySession>(`/v1/putaway/sessions/${id}/pause`, {}).then((r) => r.data),
  resume: (id: string) =>
    client.post<PutawaySession>(`/v1/putaway/sessions/${id}/resume`, {}).then((r) => r.data),
  complete: (id: string) =>
    client.post<PutawaySession>(`/v1/putaway/sessions/${id}/complete`, {}).then((r) => r.data),
};
