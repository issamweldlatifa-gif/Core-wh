import client from '../../api/client';

/** An arrival that can be received (EXPECTED / RECEIVING / PAUSED). */
export interface ReceivingArrival {
  id: string;
  code: string;
  customerName: string;
  storeName: string | null;
  status: string;
  products: number;
  units: number;
  shipments: number;
  carrier: string | null;
  tracking: string | null;
  cartons: number;
}

export interface ReceivingProduct {
  id: string;
  sku: string | null;
  reference: string | null;
  productName: string | null;
  variant: string | null;
  expected: number;
  received: number;
  remaining: number;
  status: string;
}

export interface ExpectedCarton {
  id: string;
  externalCartonId: string | null;
  reference: string | null;
  qrCodeValue: string | null;
  barcodeValue: string | null;
  cartonNumber: number | null;
  totalCartons: number | null;
  status: string;
  weight: number | null;
  weightUnit: string | null;
}

export interface ReceivedCartonEvent {
  id: string;
  code: string;
  status: string;
  scanType: string;
  receivedAt: string | null;
}

export interface ReceivingDiscrepancy {
  id: string;
  type: string;
  status: string;
  cartonCode: string | null;
  sku: string | null;
  expectedQty: number | null;
  receivedQty: number | null;
  description: string | null;
  resolution: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
}

export interface Tally {
  expectedCartons: number;
  receivedCartons: number;
  expectedProducts: number;
  receivedProducts: number;
  expectedUnits: number;
  receivedUnits: number;
  openDiscrepancies: number;
  shortUnits: number;
  overageUnits: number;
  unexpectedProducts: number;
  missingCartons: number;
}

export interface Flash {
  kind: string;
  message?: string;
  carton?: any;
  shipment?: any;
  arrival?: any;
  sku?: string;
  expected?: number;
  received?: number;
  [k: string]: any;
}

export interface ReceivingSessionDetail {
  id: string;
  code: string;
  status: string;
  startedByName: string | null;
  startedAt: string;
  endedAt: string | null;
  arrival: { id: string; code: string; customerName: string; storeName: string | null; status: string };
  shipment: any | null;
  expectedCartons: ExpectedCarton[];
  cartons: ExpectedCarton[];
  receivedCartonEvents: ReceivedCartonEvent[];
  products: ReceivingProduct[];
  discrepancies: ReceivingDiscrepancy[];
  tally: Tally;
  flash?: Flash | null;
}

export const api = {
  arrivals: () =>
    client.get<ReceivingArrival[]>('/v1/receiving/arrivals').then((r) => r.data),
  active: (idOrCode: string) =>
    client
      .get<ReceivingSessionDetail | null>(`/v1/receiving/arrivals/${encodeURIComponent(idOrCode)}/active`)
      .then((r) => r.data),
  start: (idOrCode: string) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/arrivals/${encodeURIComponent(idOrCode)}/start`, {})
      .then((r) => r.data),
  session: (id: string) =>
    client.get<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(id)}`).then((r) => r.data),
  scanCarton: (sessionId: string, code: string, scanType: 'QR' | 'BARCODE' | 'MANUAL', operationId?: string) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/scan-carton`, {
        code,
        scanType,
        operationId,
      })
      .then((r) => r.data),
  receiveCarton: (sessionId: string, cartonId: string, operationId?: string) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/receive-carton`, {
        cartonId,
        operationId,
      })
      .then((r) => r.data),
  receiveProduct: (sessionId: string, sku: string, quantity: number) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/receive-product`, {
        sku,
        quantity,
      })
      .then((r) => r.data),
  pause: (sessionId: string) =>
    client.post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/pause`, {}).then((r) => r.data),
  resume: (sessionId: string) =>
    client.post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/resume`, {}).then((r) => r.data),
  flag: (sessionId: string, body: { code?: string; sku?: string; reason?: string }) =>
    client.post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/flag`, body).then((r) => r.data),
  resolve: (discrepancyId: string, resolution: string) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/discrepancies/${encodeURIComponent(discrepancyId)}/resolve`, {
        resolution,
      })
      .then((r) => r.data),
  complete: (sessionId: string) =>
    client.post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/complete`, {}).then((r) => r.data),
};
