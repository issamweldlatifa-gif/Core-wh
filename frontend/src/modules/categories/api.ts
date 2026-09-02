import client from '../../api/client';

/** Category Master + Category -> Zone sorting configuration client. */

export interface CategoryZoneMapping {
  id: string;
  zoneId: string;
  zone: { id: string; code: string; name: string; warehouseId: string };
}

export interface Category {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  subcategories: string[];
  zoneMappings: CategoryZoneMapping[];
}

export const categoriesApi = {
  list: () => client.get<Category[]>('/v1/categories').then((r) => r.data),
  create: (d: { code: string; name?: string; subcategories?: string[] }) =>
    client.post<Category>('/v1/categories', d).then((r) => r.data),
  update: (id: string, d: { name?: string; subcategories?: string[] }) =>
    client.patch<Category>(`/v1/categories/${id}`, d).then((r) => r.data),
  setStatus: (id: string, status: 'ACTIVE' | 'INACTIVE') =>
    client.post<Category>(`/v1/categories/${id}/status`, { status }).then((r) => r.data),
  setMapping: (id: string, zoneId: string) =>
    client.post(`/v1/categories/${id}/zone-mapping`, { zoneId }).then((r) => r.data),
  removeMapping: (id: string, zoneId: string) =>
    client.delete(`/v1/categories/${id}/zone-mapping/${zoneId}`).then((r) => r.data),
};
