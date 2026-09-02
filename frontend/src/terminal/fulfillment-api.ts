import client from '../api/client';

/**
 * Typed client for the operational-flow API: containers, article scans,
 * sorting/storage, customer order sorting, packing and shipping.
 */

export interface OpContainer {
  id: string;
  code: string;
  type: 'RECEIVING' | 'CUSTOMER';
  status: 'ACTIVE' | 'READY_FOR_PACKING' | 'PACKED' | 'CLOSED';
  label: string | null;
  order?: { externalOrderReference: string; externalCustomerReference: string } | null;
  _count?: { articles: number };
}

export interface PublicArticle {
  code: string;
  sku: string;
  productName: string | null;
  category: string | null;
  subcategory: string | null;
  categoryStatus: 'CONFIRMED' | 'NEEDS_REVIEW';
  status: string;
}

export type SortingScanResult =
  | { kind: 'DESTINATION'; article: PublicArticle; zone: { id: string; code: string; name: string }; suggestedLocations: string[] }
  | { kind: 'NEEDS_REVIEW'; action: string; article: PublicArticle }
  | { kind: 'UNMAPPED'; article: PublicArticle }
  | { kind: 'AMBIGUOUS'; article: PublicArticle }
  | { kind: 'REJECTED'; reason: string; article: PublicArticle };

export type OrderSortingScanResult =
  | {
      kind: 'ASSIGNMENT';
      article: PublicArticle;
      order: { reference: string; customer: string };
      orderItemId: string;
      bin: { code: string; label: string | null } | null;
      binMissing: boolean;
    }
  | { kind: 'NO_ORDER'; reason: string; article: PublicArticle }
  | { kind: 'REJECTED'; reason: string; article: PublicArticle };

export interface PackingView {
  bin: { code: string; label: string | null; status: string };
  order: { reference: string; customer: string };
  required: Array<{ sku: string; productName: string; requested: number; inBin: number }>;
  articles: Array<{ code: string; sku: string; productName: string | null; status: string }>;
  complete: boolean;
}

export interface OutboundShipmentView {
  code: string;
  status: 'READY_TO_SHIP' | 'SHIPPED';
  carrier: string | null;
  trackingNumber: string | null;
  order?: { externalOrderReference: string; externalCustomerReference: string };
  articles?: Array<{ code: string; sku: string; productName: string | null; status: string }>;
  container?: { code: string } | null;
  shippedAt?: string | null;
}

const v1 = '/v1/fulfillment';

export const fulfillmentApi = {
  // containers
  createContainer: (body: { type: 'RECEIVING' | 'CUSTOMER'; label?: string; orderReference?: string }) =>
    client.post<OpContainer>(`${v1}/containers`, body).then((r) => r.data),
  containers: (params?: { type?: string; status?: string }) =>
    client.get<OpContainer[]>(`${v1}/containers`, { params }).then((r) => r.data),
  container: (code: string) => client.get(`${v1}/containers/${encodeURIComponent(code)}`).then((r) => r.data),

  // receiving article scan
  scanArticle: (sessionId: string, body: { sku: string; containerCode: string; cartonCode?: string }) =>
    client.post(`${v1}/receiving/sessions/${sessionId}/scan-article`, body).then((r) => r.data),

  // sorting + storage
  sortingScan: (articleCode: string) =>
    client.get<SortingScanResult>(`${v1}/sorting/articles/${encodeURIComponent(articleCode)}`).then((r) => r.data),
  sortingStore: (body: { articleCode: string; locationCode: string }) =>
    client.post(`${v1}/sorting/store`, body).then((r) => r.data),

  // customer order sorting
  orderSortingScan: (articleCode: string) =>
    client
      .get<OrderSortingScanResult>(`${v1}/order-sorting/articles/${encodeURIComponent(articleCode)}`)
      .then((r) => r.data),
  orderSortingAssign: (body: { articleCode: string; containerCode: string }) =>
    client.post(`${v1}/order-sorting/assign`, body).then((r) => r.data),

  // packing
  packingScan: (containerCode: string) =>
    client.get<PackingView>(`${v1}/packing/containers/${encodeURIComponent(containerCode)}`).then((r) => r.data),
  pack: (containerCode: string) =>
    client.post(`${v1}/packing/containers/${encodeURIComponent(containerCode)}/pack`).then((r) => r.data),

  // shipping
  shippingScan: (code: string) =>
    client.get<OutboundShipmentView>(`${v1}/shipping/shipments/${encodeURIComponent(code)}`).then((r) => r.data),
  ship: (code: string) =>
    client.post(`${v1}/shipping/shipments/${encodeURIComponent(code)}/ship`).then((r) => r.data),

  // traceability (admin)
  trace: (articleCode: string) =>
    client.get(`${v1}/articles/${encodeURIComponent(articleCode)}/trace`).then((r) => r.data),
};
