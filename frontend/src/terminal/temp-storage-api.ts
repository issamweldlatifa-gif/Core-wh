import client from '../api/client';

/**
 * Temporary Storage worker API (Web Terminal / CT40).
 *
 * Backend authority only (§2/§9): every flow decision — customer resolution,
 * section letter, target container, VALID/WRONG/CARTON rejection — comes from
 * the Temporary Storage service. The UI merely renders what the server says
 * and highlights the container the server designates.
 */

export interface TsContainerCard {
  code: string;
  current: number;
  capacity: number;
  status: 'EMPTY' | 'ACTIVE' | 'FULL' | 'REVIEW';
  active?: boolean;
}

export interface TsHome {
  station: { id: string; code: string; name: string; department: string };
  header: {
    activeProducts: number;
    containers: number;
    completed: number;
    remaining: number;
    review: number;
  };
  currentSection: string | null;
  sections: Array<{
    letter: string;
    products: number;
    stored: number;
    customers: Array<{ customer: string; received: number; remaining: number }>;
  }>;
}

export interface TsSectionBoard {
  station: { id: string; code: string; name: string };
  letter: string;
  reviewItems: Array<{
    id: string;
    sku: string | null;
    reference: string | null;
    productName: string | null;
    customerName: string | null;
    reason: string | null;
    scannedAt: string;
    scannedBy: string | null;
  }>;
  customers: Array<{
    customer: string;
    surname: string | null;
    received: number;
    stored: number;
    remaining: number;
    containers: TsContainerCard[];
    hasReview: boolean;
  }>;
}

export interface TsScanResult {
  status: 'VALID' | 'CARTON_NOT_ALLOWED' | 'ALREADY_STORED' | 'PRODUCT_NOT_FOUND';
  message?: string;
  product?: {
    sku: string | null;
    reference: string | null;
    productName: string | null;
    customer: string;
    surname?: string | null;
    section: string;
  };
  remaining?: number;
  targetContainer?: {
    code: string;
    current: number;
    capacity: number;
    status: string;
    mustCreate: boolean;
  };
}

export interface TsPlaceResult {
  status: 'VALID' | 'WRONG_CONTAINER' | 'REVIEW' | 'ALREADY_IN_REVIEW' | 'CARTON_NOT_ALLOWED' | 'ALREADY_STORED' | 'AT_OTHER_STATION';
  message?: string;
  itemId?: string;
  container?: { code: string; current: number; capacity: number; status: string };
  remaining?: number;
  nextTarget?: { code: string; current: number; capacity: number; status: string } | null;
  expected?: { section: string; containerCode: string } | null;
}

export interface TsReviewResult {
  status: 'REVIEW' | 'ALREADY_IN_REVIEW';
  review?: { itemId: string; exceptionCode?: string | null; reason?: string | null };
  notifiedAdmins?: number;
}

export interface TsReportResult {
  status?: string;
  id?: string;
  stationCode?: string;
  notifiedAdmins?: number;
  message?: string;
}

let scanSeq = 0;
/** One physical scan attempt = one fresh operation id (idempotency on the server). */
export function newOperationId(): string {
  scanSeq += 1;
  return `tsw-${Date.now().toString(36)}-${scanSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const tsApi = {
  home: () => client.get<TsHome>('/v1/temporary-storage/home').then((r) => r.data),
  section: (letter: string) => client.get<TsSectionBoard>(`/v1/temporary-storage/sections/${encodeURIComponent(letter)}`).then((r) => r.data),
  scan: (code: string, operationId: string) =>
    client.post<TsScanResult>('/v1/temporary-storage/scan', { code, operationId }).then((r) => r.data),
  place: (code: string, containerCode: string, operationId: string) =>
    client.post<TsPlaceResult>('/v1/temporary-storage/place', { code, containerCode, operationId }).then((r) => r.data),
  review: (code: string, reason: string, operationId: string) =>
    client.post<TsReviewResult>('/v1/temporary-storage/review', { code, reason, toReview: true, operationId }).then((r) => r.data),
  reportFin: (observation?: string) =>
    client.post<TsReportResult>('/v1/temporary-storage/report', { observation: observation ?? null }).then((r) => r.data),
};
