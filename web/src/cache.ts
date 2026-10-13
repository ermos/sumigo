import { useEffect, useState } from 'react';

// Stale-while-revalidate cache, like Decap: pages render instantly from what was already
// loaded, then refresh from GitHub in the background. Kept in memory and mirrored to
// sessionStorage so a reload stays instant; cleared on logout.
const PREFIX = 'sumigo:';
const memory = new Map<string, unknown>();

export function getCached<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw) {
      const v = JSON.parse(raw) as T;
      memory.set(key, v);
      return v;
    }
  } catch {
    // storage unavailable or corrupted, ignore
  }
  return undefined;
}

export function setCached<T>(key: string, value: T) {
  memory.set(key, value);
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // quota exceeded or storage unavailable: memory cache still works
  }
}

export function clearCache() {
  memory.clear();
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // ignore
  }
}

// useCached returns the cached value right away and refreshes it with fetcher.
export function useCached<T>(key: string, fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(() => getCached<T>(key));
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let live = true;
    setData(getCached<T>(key));
    setError('');
    setRefreshing(true);
    fetcher()
      .then((v) => {
        setCached(key, v);
        if (live) setData(v);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setRefreshing(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);

  return { data, error, refreshing };
}
