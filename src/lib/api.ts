/**
 * Thin fetch wrapper.
 *
 * Every API error comes back as `{ error, message }`, and the `message` is
 * written to be shown to a user rather than to a log. So the rule here is: if
 * the server said something, show exactly what it said. Swallowing it and
 * replacing it with "Something went wrong" would throw away the most useful
 * signal in the whole system — the server is usually telling you it refused to
 * save something, or that a key was revoked, and that deserves to be visible.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const startedAt = Date.now();
  console.info(`[api] ${method} ${path} → sending`);
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; message?: string };
    console.error(
      `[api] ${method} ${path} → ${response.status} (${body.error ?? "no code"}) in ${Date.now() - startedAt}ms: ${body.message ?? "no message"}`,
    );
    throw new ApiError(
      response.status,
      body.error ?? "unknown",
      body.message ?? `Request failed with ${response.status}.`,
    );
  }

  console.info(`[api] ${method} ${path} → ${response.status} in ${Date.now() - startedAt}ms`);
  return payload as T;
}

/**
 * GET cache with mutation invalidation.
 *
 * Every tab fetches on mount, and every one of those endpoints reads the full
 * ledger server-side. Without this, switching tabs is a relayer round trip each
 * time -- which is why the tabs felt slow. The server caches for 15s; this
 * stretches that to 30s client-side and, more importantly, dedupes concurrent
 * identical requests, so a double-mounted view fires one fetch instead of two.
 *
 * Invalidation is deliberately coarse: ANY mutation busts the whole cache. A
 * profile save busting the task-list entry is slightly wasteful, but a surgical
 * scheme that misses one case serves stale tasks -- and a "Done" button whose
 * tap visibly does nothing is worse than one extra fetch. Correctness first.
 *
 * Errors are never cached. A failed GET must retry next time, not serve the
 * failure for thirty seconds.
 */
// 60s to match the server. Same guarantee (any mutation busts), so tab switches
// stay instant for a full minute of browsing instead of half of one.
const GET_TTL_MS = 60_000;
const getCache = new Map<string, { at: number; value: unknown }>();
const getInflight = new Map<string, Promise<unknown>>();

// A generation counter: bustGetCache bumps it, and a fetch that started before
// the bump must not populate the cache afterwards.
let cacheGeneration = 0;

function bustGetCache(): void {
  cacheGeneration++;
  getCache.clear();
  // In-flight requests are left to land: they were issued before the mutation,
  // so their data predates it, and dropping them would turn a settled write into
  // a hanging promise. They simply are not stored (see below).
}

async function cachedGet<T>(path: string): Promise<T> {
  const cached = getCache.get(path);
  if (cached && Date.now() - cached.at < GET_TTL_MS) return cached.value as T;

  const inflight = getInflight.get(path);
  if (inflight) return inflight as Promise<T>;

  const startedGeneration = cacheGeneration;
  const pending = request<T>(path).then(
    (value) => {
      getInflight.delete(path);
      // Only store if no mutation landed while we were away. A write that
      // completed mid-fetch makes this response stale on arrival.
      if (startedGeneration === cacheGeneration) getCache.set(path, { at: Date.now(), value });
      return value;
    },
    (error) => {
      getInflight.delete(path);
      throw error;
    },
  );
  getInflight.set(path, pending);
  return pending;
}

export const api = {
  get: <T>(path: string) => cachedGet<T>(path),
  post: <T>(path: string, body?: unknown) => {
    bustGetCache();
    return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
  },
  del: <T>(path: string) => {
    bustGetCache();
    return request<T>(path, { method: "DELETE" });
  },
  /** Test-only: how many entries are cached. */
  _cacheSizeForTests: () => getCache.size,
  /** Test-only: clear cache and in-flight map between cases. */
  _resetForTests: () => {
    getCache.clear();
    getInflight.clear();
  },
};
