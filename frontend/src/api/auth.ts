import client, { clearTokens, storeTokens } from './client';
import type { AuthMe, AuthTokens } from '../types/auth';

export type LoginApplication = 'ADMIN_WEB' | 'WORKER_NATIVE';

export async function login(
  identifier: string,
  secret: string,
  app: LoginApplication = 'ADMIN_WEB',
): Promise<AuthTokens> {
  const res = await client.post<AuthTokens>('/v1/auth/login', { identifier, secret, app });
  storeTokens(res.data.accessToken, res.data.refreshToken);
  return res.data;
}

export async function refreshToken(): Promise<AuthTokens | null> {
  const refresh = localStorage.getItem('ayrovi_refresh_token');
  if (!refresh) return null;
  try {
    const res = await client.post<AuthTokens>('/v1/auth/refresh', { refreshToken: refresh });
    storeTokens(res.data.accessToken, res.data.refreshToken);
    return res.data;
  } catch {
    clearTokens();
    return null;
  }
}

export async function getMe(): Promise<AuthMe> {
  const res = await client.get<AuthMe>('/v1/auth/me');
  return res.data;
}

export async function logout(): Promise<void> {
  try {
    await client.post('/v1/auth/logout');
  } finally {
    clearTokens();
  }
}
