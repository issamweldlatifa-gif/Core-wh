import client from '../../api/client';

export interface ExpectedArrivalItem {
  id: string;
  productId: string | null;
  sku: string | null;
  reference: string | null;
  productName: string | null;
  quantity: number;
  variant: string | null;
  color: string | null;
  size: string | null;
  /** CRM-pushed category (UPPERCASE). null = UNKNOWN — needs review. */
  category: string | null;
  subcategory?: string | null;
  /** CRM classification origin: AI | MANUAL. */
  classificationSource?: string | null;
  /** Verdict against the Category Master. */
  categoryStatus?: 'CONFIRMED' | 'NEEDS_REVIEW';
  storeId: string | null;
  storeName: string | null;
}

export interface ChangeCategoryPayload {
  category: string;
  subcategory?: string | null;
}

export interface ExpectedArrival {
  id: string;
  code: string;
  warehouseArrivalId: string;
  customerArrivalCardId: string;
  arrivalId: string | null;
  arrivalReference: string | null;
  customerId: string;
  customerName: string;
  storeId: string | null;
  storeName: string | null;
  status: 'EXPECTED';
  source: 'ARRIVAL_CRM';
  products: number;
  units: number;
  receivedViaApi: boolean;
  receivedViaApiAt: string | null;
  createdAt: string;
}

export interface ExpectedArrivalListResp {
  data: ExpectedArrival[];
  total: number;
  take: number;
  skip: number;
}

export interface ExpectedArrivalDetail extends ExpectedArrival {
  apiClientId: string | null;
  idempotencyKey: string | null;
  items: ExpectedArrivalItem[];
}

export const api = {
  list: () =>
    client
      .get<ExpectedArrivalListResp>('/v1/expected-arrivals', { params: { take: 200 } })
      .then((r) => r.data),
  detail: (idOrCode: string) =>
    client
      .get<ExpectedArrivalDetail>(`/v1/expected-arrivals/${encodeURIComponent(idOrCode)}`)
      .then((r) => r.data),
  /** Manual resolution of a NEEDS REVIEW line against the Category Master (audited). */
  changeCategory: (itemId: string, payload: ChangeCategoryPayload) =>
    client
      .post(`/v1/expected-arrivals/items/${encodeURIComponent(itemId)}/category`, payload)
      .then((r) => r.data),
};
