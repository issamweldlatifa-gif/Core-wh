import { useCallback, useEffect, useState } from 'react';
import { AxiosRequestConfig } from 'axios';
import client, { apiErrorMessage } from '../api/client';

/** Lightweight data-fetch hook with loading/error/data states. */
export function useFetch<T>(url: string, config?: AxiosRequestConfig) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const trigger = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.get<T>(url, config);
      setData(res.data);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    trigger();
  }, [trigger]);

  return { data, loading, error, reload: trigger };
}
