import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import * as authApi from '../api/auth';
import { getAccessToken, clearTokens } from '../api/client';
import type { AuthMe } from '../types/auth';

interface AuthContextValue {
  me: AuthMe | null;
  loading: boolean;
  error: string | null;
  loginFn: (identifier: string, secret: string) => Promise<void>;
  logoutFn: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    if (!getAccessToken()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const data = await authApi.getMe();
      setMe(data);
      setError(null);
    } catch {
      clearTokens();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const loginFn = useCallback(async (identifier: string, secret: string) => {
    setError(null);
    try {
      await authApi.login(identifier, secret);
      const data = await authApi.getMe();
      setMe(data);
    } catch (e: any) {
      // Re-throw so the login screen can render the error state.
      const msg = e?.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Login failed.'));
      throw e;
    }
  }, []);

  const logoutFn = useCallback(async () => {
    await authApi.logout();
    setMe(null);
  }, []);

  const hasPermission = useCallback(
    (perm: string) => (me?.permissions ?? []).includes(perm),
    [me],
  );

  const value = useMemo(
    () => ({ me, loading, error, loginFn, logoutFn, hasPermission }),
    [me, loading, error, loginFn, logoutFn, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
