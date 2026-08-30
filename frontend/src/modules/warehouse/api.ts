import client from '../../api/client';

// ---------------------------------------------------------------------------
// Phase 1 physical warehouse structure — typed API helpers.
// The axios client baseURL is `/api`, so these call `/api/v1/<resource>`.
// ---------------------------------------------------------------------------

export interface Warehouse {
  id: string; code: string; name: string; description: string | null;
  status: 'ACTIVE' | 'INACTIVE'; createdAt: string; updatedAt: string;
}
export interface Zone {
  id: string; warehouseId: string; code: string; name: string; description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}
export interface Aisle { id: string; zoneId: string; code: string; name: string; status: 'ACTIVE' | 'INACTIVE' }
export interface Rack { id: string; aisleId: string; code: string; name: string; status: 'ACTIVE' | 'INACTIVE' }
export interface Level { id: string; rackId: string; code: string; levelNumber: number; status: 'ACTIVE' | 'INACTIVE' }
export type LocationType = 'STORAGE' | 'RECEIVING' | 'SORTING' | 'PACKING' | 'RETURNS' | 'QC' | 'STAGING';
export type LocationStatus = 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
export interface Location {
  id: string; warehouseId: string; zoneId: string; aisleId: string; rackId: string; levelId: string;
  locationCode: string; barcodeValue: string; qrValue: string | null;
  locationType: LocationType; status: LocationStatus;
  maxWeight: number | null; maxVolume: number | null; maxUnits: number | null;
}
export interface LocationPaged { items: Location[]; total: number; skip: number; take: number }
export interface StructureNode {
  id: string; code: string; name: string; status: string;
  aisles?: StructureNode[];
  racks?: StructureNode[];
  levels?: (Level & { locations: Location[] })[];
}

const up = (s: string) => (s ?? '').trim().toUpperCase();

export const api = {
  warehouses: () => client.get<Warehouse[]>('/v1/warehouses').then(r => r.data),
  createWarehouse: (d: { code: string; name: string; description?: string }) =>
    client.post<Warehouse>('/v1/warehouses', { ...d, code: up(d.code) }).then(r => r.data),
  updateWarehouse: (id: string, d: { name?: string; description?: string; code?: string }) =>
    client.patch<Warehouse>(`/v1/warehouses/${id}`, d).then(r => r.data),
  warehouseStatus: (id: string, s: 'ACTIVE' | 'INACTIVE') =>
    client.post<Warehouse>(`/v1/warehouses/${id}/${s === 'ACTIVE' ? 'activate' : 'deactivate'}`).then(r => r.data),
  warehouseStructure: (id: string) => client.get<StructureNode[]>(`/v1/warehouses/${id}/structure`).then(r => r.data),

  zones: (warehouseId: string) => client.get<Zone[]>(`/v1/zones`, { params: { warehouseId } }).then(r => r.data),
  createZone: (d: { warehouseId: string; code: string; name: string }) =>
    client.post<Zone>('/v1/zones', { ...d, code: up(d.code) }).then(r => r.data),
  zoneStatus: (id: string, s: 'ACTIVE' | 'INACTIVE') =>
    client.post<Zone>(`/v1/zones/${id}/${s === 'ACTIVE' ? 'activate' : 'deactivate'}`).then(r => r.data),

  aisles: (zoneId: string) => client.get<Aisle[]>(`/v1/aisles`, { params: { zoneId } }).then(r => r.data),
  createAisle: (d: { zoneId: string; code: string; name: string }) =>
    client.post<Aisle>('/v1/aisles', { ...d, code: up(d.code) }).then(r => r.data),
  aisleStatus: (id: string, s: 'ACTIVE' | 'INACTIVE') =>
    client.post<Aisle>(`/v1/aisles/${id}/${s === 'ACTIVE' ? 'activate' : 'deactivate'}`).then(r => r.data),

  racks: (aisleId: string) => client.get<Rack[]>(`/v1/racks`, { params: { aisleId } }).then(r => r.data),
  createRack: (d: { aisleId: string; code: string; name: string }) =>
    client.post<Rack>('/v1/racks', { ...d, code: up(d.code) }).then(r => r.data),
  rackStatus: (id: string, s: 'ACTIVE' | 'INACTIVE') =>
    client.post<Rack>(`/v1/racks/${id}/${s === 'ACTIVE' ? 'activate' : 'deactivate'}`).then(r => r.data),

  levels: (rackId: string) => client.get<Level[]>(`/v1/levels`, { params: { rackId } }).then(r => r.data),
  createLevel: (d: { rackId: string; levelNumber: number }) =>
    client.post<Level>('/v1/levels', d).then(r => r.data),
  levelStatus: (id: string, s: 'ACTIVE' | 'INACTIVE') =>
    client.post<Level>(`/v1/levels/${id}/${s === 'ACTIVE' ? 'activate' : 'deactivate'}`).then(r => r.data),

  locations: (params: { warehouseId?: string; zoneId?: string; status?: string; locationType?: string; skip?: number; take?: number }) =>
    client.get<LocationPaged>('/v1/locations', { params }).then(r => r.data),
  searchLocations: (q: string, params: { warehouseId?: string; zoneId?: string; status?: string; locationType?: string }) =>
    client.get<LocationPaged>('/v1/locations/search', { params: { q, ...params } }).then(r => r.data),
  createLocation: (d: { warehouseId: string; zoneId: string; aisleId: string; rackId: string; levelId: string; locationType: LocationType; maxUnits?: number }) =>
    client.post<Location>('/v1/locations', d).then(r => r.data),
  locationStatus: (id: string, action: 'activate' | 'deactivate' | 'block' | 'unblock') =>
    client.post<Location>(`/v1/locations/${id}/${action}`).then(r => r.data),
};
