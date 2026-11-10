/**
 * Read-only client for Quo's REST API (version 2026-03-30), used by the
 * call-log backfill. Nothing here writes to Quo.
 *
 *   Authorization: <raw key>   (no "Bearer")
 *   Quo-Api-Version: 2026-03-30   (required; Quo has no default)
 *
 * Quo allows 10 requests a second per key, and the key is shared with SMS, so
 * this client spaces its own requests at least `minIntervalMs` apart (default
 * 200 ms = 5 a second). A 429 or a 5xx is retried with exponential backoff and
 * jitter, `maxRetries` times; Quo documents no Retry-After header.
 *
 * Every failure is a QuoApiError with a `kind`. Its message names the kind,
 * the HTTP status and the path only: never the key, a query string, a
 * response body or call content.
 */

export const QUO_API_BASE = "https://api.quo.com";
export const QUO_API_VERSION = "2026-03-30";

export type QuoApiErrorKind =
  | "unauthorized" // 401 / 403
  | "not_found" // 404
  | "rate_limited" // 429 after every retry
  | "http" // any other non-2xx, after retries for 5xx
  | "network" // fetch threw
  | "timeout" // no answer within timeoutMs
  | "bad_response" // 2xx but not the documented JSON shape
  | "request_cap"; // this run's request budget is spent

export class QuoApiError extends Error {
  constructor(
    readonly kind: QuoApiErrorKind,
    readonly status: number | null,
    readonly path: string,
  ) {
    super(`Quo API ${kind}${status !== null ? ` (${status})` : ""} on ${path}`);
    this.name = "QuoApiError";
  }
}

export interface QuoPage<T> {
  data: T[];
  nextCursor: string | null;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export interface QuoClientOptions {
  key: string;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Hard cap on HTTP requests this client will make (retries count). */
  maxRequests?: number;
}

export interface QuoClient {
  getPage<T>(path: string, query?: Record<string, string | undefined>): Promise<QuoPage<T>>;
  /** Requests made so far, retries included. */
  readonly requests: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createQuoClient(opts: QuoClientOptions): QuoClient {
  const doFetch: FetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const minInterval = opts.minIntervalMs ?? 200;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRequests = opts.maxRequests ?? 300;
  let requests = 0;
  let lastAt = -Infinity;

  async function once(path: string, url: string): Promise<{ status: number; body: unknown }> {
    if (requests >= maxRequests) throw new QuoApiError("request_cap", null, path);
    const wait = lastAt + minInterval - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
    requests++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { Authorization: opts.key, "Quo-Api-Version": QUO_API_VERSION },
        signal: ctl.signal,
      });
      if (res.status < 200 || res.status >= 300) return { status: res.status, body: null };
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new QuoApiError("bad_response", res.status, path);
      }
      return { status: res.status, body };
    } catch (e) {
      if (e instanceof QuoApiError) throw e;
      const aborted = ctl.signal.aborted || (e as { name?: string })?.name === "AbortError";
      throw new QuoApiError(aborted ? "timeout" : "network", null, path);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getPage<T>(path: string, query: Record<string, string | undefined> = {}): Promise<QuoPage<T>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, v);
    const search = qs.toString();
    const url = `${QUO_API_BASE}${path}${search ? `?${search}` : ""}`;

    for (let attempt = 0; ; attempt++) {
      const { status, body } = await once(path, url);
      if (status >= 200 && status < 300) {
        const b = body as { data?: unknown; nextCursor?: unknown } | null;
        if (!b || !Array.isArray(b.data)) throw new QuoApiError("bad_response", status, path);
        const next = typeof b.nextCursor === "string" && b.nextCursor !== "" ? b.nextCursor : null;
        return { data: b.data as T[], nextCursor: next };
      }
      const retryable = status === 429 || status >= 500;
      if (retryable && attempt < maxRetries) {
        await sleep(500 * 2 ** attempt + Math.floor(random() * 250));
        continue;
      }
      if (status === 401 || status === 403) throw new QuoApiError("unauthorized", status, path);
      if (status === 404) throw new QuoApiError("not_found", status, path);
      if (status === 429) throw new QuoApiError("rate_limited", status, path);
      throw new QuoApiError("http", status, path);
    }
  }

  return {
    getPage,
    get requests() {
      return requests;
    },
  };
}
