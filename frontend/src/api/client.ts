import axios from 'axios';
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
