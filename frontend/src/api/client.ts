import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import type { ApiErrorBody } from '../types/auth';

const BASE = import.meta.env.VITE_API_BASE || '/api';

export const TOKEN_STORAGE_KEY = 'ayrovi_access_token';
export const REFRESH_TOKEN_STORAGE_KEY = 'ayrovi_refresh_token';

export const getAccessToken = () => localStorage.getItem(TOKEN_STORAGE_KEY);
export const getRefreshToken = () => localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);

export function storeTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(TOKEN_STORAGE_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
}

// Endpoints that must NEVER trigger an auto-refresh or retry (they are
// themselves the auth mechanism and would otherwise loop).
const AUTH_ENDPOINTS = ['/v1/auth/login', '/v1/auth/refresh', '/v1/auth/logout'];

const client = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
});

// Inject access token on every request.
client.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers ?? {};
    (config.headers as any).Authorization = `Bearer ${token}`;
  }
  return config;
});

// Automatically refresh the access token once when it has expired (401),
// then retry the original request. Also keeps concurrent failures from
// stampeding the refresh endpoint.
let isRefreshing = false;
let pendingRetries: Array<(value: string | null) => void> = [];
const onRefreshed = (token: string | null) => {
  pendingRetries.forEach((resolve) => resolve(token));
  pendingRetries = [];
};

async function refreshAccessToken(): Promise<string | null> {
  const refresh = getRefreshToken();
  if (!refresh) return null;
  try {
    const res = await axios.post(`${BASE}/v1/auth/refresh`, { refreshToken: refresh });
    storeTokens(res.data.accessToken, res.data.refreshToken);
    return res.data.accessToken as string;
  } catch {
    clearTokens();
    return null;
  }
}

client.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error)) throw error;
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;

    const status = error.response?.status;
    const url = original?.url ?? '';
    const isAuthCall = AUTH_ENDPOINTS.some((e) => url.includes(e));

    // Only auto-refresh on an expired access token for a protected call.
    if (status === 401 && original && !original._retry && !isAuthCall) {
      original._retry = true;

      // If a refresh is already in flight, wait for it.
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          pendingRetries.push((token) => {
            if (token) {
              original.headers = original.headers ?? {};
              (original.headers as any).Authorization = `Bearer ${token}`;
              resolve(client(original));
            } else {
              reject(error);
            }
          });
        });
      }

      isRefreshing = true;
      const token = await refreshAccessToken();
      isRefreshing = false;
      onRefreshed(token);

      if (token) {
        original.headers = original.headers ?? {};
        (original.headers as any).Authorization = `Bearer ${token}`;
        return client(original);
      }
    }

    throw error;
  },
);

// Extract a human-readable message from the uniform API error envelope.
export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as ApiErrorBody | undefined;
    if (body?.message) {
      return Array.isArray(body.message) ? body.message.join(', ') : body.message;
    }
    if (body?.error) return body.error;
    return err.message || 'Request failed.';
  }
  if (err instanceof Error) return err.message;
  return 'An unexpected error occurred.';
}

export default client;
