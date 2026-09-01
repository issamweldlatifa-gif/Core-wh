import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '../../api/client';

/**
 * Small data-loading hook shared by the admin pages: keeps every screen's
 * loading/error/refresh behaviour identical (§45) without pulling in a
 * data-fetching dependency.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { void run(); }, [run]);
  return { data, loading, error, reload: run };
}
