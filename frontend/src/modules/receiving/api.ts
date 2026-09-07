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

/**
 * PRODUCT CARD (Customer Arrival Card line) — expected card data downloaded by
 * the worker device for DEVICE-SIDE MATCHING. Independent card type: the
 * PRODUIT lane only ever sees product cards. Never merged with carton data.
 */
export interface ProductCard {
  id: string;
  sku: string | null;
  reference: string | null;
  productName: string | null;
  category: string | null;
  subcategory: string | null;
  categoryStatus: 'CONFIRMED' | 'NEEDS_REVIEW';
  expected: number;
  received: number;
  remaining: number;
  status: string;
  /** Normalized (uppercased) comparison keys the device may match against. */
  identifiers: string[];
}

/**
 * CARTON CARD (Shipment Card carton) — expected card data downloaded by the
 * worker device for DEVICE-SIDE MATCHING. Independent card type: the CARTON
 * lane only ever sees carton cards. Carries the shipment-level card data
 * (tracking number, sender, shipped date) used for tracking-number matching.
 */
export interface CartonCard {
  id: string;
  externalCartonId: string;
  reference: string | null;
  qrCodeValue: string | null;
  barcodeValue: string | null;
  cartonNumber: number;
  totalCartons: number;
  trackingNumber: string | null;
  senderName: string | null;
  shippedAt: string | null;
  weight: number | null;
  weightUnit: string | null;
  dimensions: { length: number | null; width: number | null; height: number | null; unit: string | null } | null;
  status: string;
  /** Normalized (uppercased) comparison keys the device may match against. */
  identifiers: string[];
}

export interface ShipmentRef {
  id: string;
  code: string;
  externalShipmentId: string | null;
  carrierName: string | null;
  carrierCode: string | null;
  trackingNumber: string | null;
  senderName: string | null;
  senderCompany: string | null;
  shippedAt: string | null;
  totalCartons: number | null;
  totalProducts: number | null;
  totalUnits: number | null;
}

export interface ReceivingDiscrepancy {
  id: string;
  type: string;
  status: string;
  reason: string | null;
  expected: number | null;
  actual: number | null;
  difference: number | null;
  resolution: string | null;
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

/**
 * Latest flash from the backend's final validation:
 *   PRODUCT lane: MATCH | CARD_ALREADY_COMPLETE | MISMATCH
 *   CARTON lane:  MATCH | CARD_ALREADY_COMPLETE | TRACKING_AMBIGUOUS | MISMATCH | WRONG_SHIPMENT
 */
export interface Flash {
  kind: string;
  cardType?: string;
  code?: string;
  message?: string;
  sku?: string;
  expected?: number;
  received?: number;
  carton?: { id?: string; externalCartonId?: string; reference?: string; cartonNumber?: number; totalCartons?: number; trackingNumber?: string | null };
  cartons?: Array<{ externalCartonId: string; cartonNumber: number; totalCartons: number }>;
  shipment?: { code: string; externalShipmentId: string | null } | null;
  [k: string]: any;
}

export interface ReceivingSessionDetail {
  id: string;
  code: string;
  status: string;
  startedAt: string;
  pausedAt: string | null;
  completedAt: string | null;
  deviceType: string | null;
  deviceName: string | null;
  scanSource: string | null;
  arrival: { id: string; code: string; externalArrivalId: string | null; customerName: string; storeName: string | null; status: string };
  shipment: ShipmentRef | null;
  productCards: ProductCard[];
  cartonCards: CartonCard[];
  discrepancies: ReceivingDiscrepancy[];
  tally: Tally;
  flash?: Flash | null;
}

/** Input device that produced a scan (device support layer). */
export type ScanSource = 'CAMERA' | 'EXTERNAL_SCANNER' | 'MANUAL';

/** Identifier class sent with a confirm / mismatch (device-derived). */
export type IdentifierType = 'QR' | 'BARCODE' | 'OCR' | 'MANUAL';

/** One line in the Receiving Home visible card list (information only). */
export interface ReceivingHomeProductRow {
  arrivalCode: string;
  reference: string | null;
  label: string | null;
  remaining: number;
}
export interface ReceivingHomeCartonRow {
  arrivalCode: string;
  reference: string;
  tracking: string | null;
  remaining: number;
}

/**
 * RECEIVING HOME payload — the automatic-dispatch worker feed.
 * `productCards` / `cartonCards` are the device-side matching corpora (the
 * worker never chooses a card); `*Pending` drive the home counters and the
 * `*List` arrays are the visible "what arrived" enumeration.
 */
export interface ReceivingHome {
  productCards: ProductCard[];
  cartonCards: CartonCard[];
  productCardsPending: number;
  cartonCardsPending: number;
  productList: ReceivingHomeProductRow[];
  cartonList: ReceivingHomeCartonRow[];
  arrivals: Array<{ id: string; code: string; customerName: string }>;
  worker: { id: string; name: string | null };
}

/** Response shape of a home scan (confirm or mismatch). */
export interface HomeScanResult {
  ok: boolean;
  sessionId?: string | null;
  flash?: Flash | null;
  home: ReceivingHome;
}

export const api = {
  /** RECEIVING HOME: the worker's available PRODUCT + CARTON cards + counters. */
  home: () => client.get<ReceivingHome>('/v1/receiving/home').then((r) => r.data),
  /** PRODUCT scan from Receiving Home (backend auto-resolves the session). */
  homeProduct: (body: {
    identifier: string;
    identifierType: IdentifierType;
    quantity?: number;
    source: ScanSource;
    operationId: string;
    startedAt: string;
  }) => client.post<HomeScanResult>('/v1/receiving/home/product', body).then((r) => r.data),
  /** CARTON scan from Receiving Home (backend auto-resolves the session). */
  homeCarton: (body: {
    identifier: string;
    identifierType: IdentifierType;
    source: ScanSource;
    operationId: string;
    startedAt: string;
  }) => client.post<HomeScanResult>('/v1/receiving/home/carton', body).then((r) => r.data),
  /** Device-side MISMATCH from Receiving Home (nothing confirmed/completed). */
  homeMismatch: (body: {
    cardType: 'PRODUCT' | 'CARTON';
    identifier: string;
    identifierType: IdentifierType;
    source: ScanSource;
    startedAt: string;
  }) => client.post<HomeScanResult>('/v1/receiving/home/mismatch', body).then((r) => r.data),
  arrivals: () =>
    client.get<ReceivingArrival[]>('/v1/receiving/arrivals').then((r) => r.data),
  active: (idOrCode: string) =>
    client
      .get<ReceivingSessionDetail | null>(`/v1/receiving/arrivals/${encodeURIComponent(idOrCode)}/active`)
      .then((r) => (r.data ? r.data : null)),
  start: (idOrCode: string, device?: { deviceType?: string; deviceName?: string; scanSource?: string }) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/arrivals/${encodeURIComponent(idOrCode)}/start`, device ?? {})
      .then((r) => r.data),
  session: (id: string) =>
    client.get<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(id)}`).then((r) => r.data),
  /**
   * PRODUCT lane confirm — the device already matched the identifier locally;
   * the backend re-validates, persists, logs the worker activity and returns
   * the flash (MATCH / CARD_ALREADY_COMPLETE / MISMATCH).
   */
  confirmProduct: (
    sessionId: string,
    body: { identifier: string; identifierType: IdentifierType; quantity: number; source: ScanSource; operationId: string; startedAt: string },
  ) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/confirm-product`, body)
      .then((r) => r.data),
  /** CARTON lane confirm — identifier (card or tracking), backend is final authority. */
  confirmCarton: (
    sessionId: string,
    body: { identifier: string; identifierType: IdentifierType; source: ScanSource; operationId: string; startedAt: string },
  ) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/confirm-carton`, body)
      .then((r) => r.data),
  /** Device-side matching found no card — nothing is confirmed, the failure is logged. */
  reportMismatch: (
    sessionId: string,
    body: { cardType: 'PRODUCT' | 'CARTON'; identifier: string; identifierType: IdentifierType; source: ScanSource; startedAt: string },
  ) =>
    client
      .post<ReceivingSessionDetail>(`/v1/receiving/sessions/${encodeURIComponent(sessionId)}/mismatch`, body)
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
