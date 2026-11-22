import { useCallback, useEffect, useState } from "react";

export interface ApiState<T> { data: T | null; error: string | null; loading: boolean; retry: () => void }

/** Runs `fn` whenever `deps` change; exposes error + retry. Stale responses are ignored. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => { if (alive) { setData(d); setLoading(false); } },
      (e) => { if (alive) { setData(null); setError(e?.message ?? "Something went wrong"); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, retry };
}
