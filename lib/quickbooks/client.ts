import "server-only";
import { getQuickBooksConfig } from "./config";
import { forceExpireAccessToken, getValidAccessToken } from "./tokens";

/**
 * Authenticated fetch against the QuickBooks Accounting API.
 *
 * Flow per call:
 *   1. getValidAccessToken() — lazy refresh if within 5 min of expiry (Layer 1).
 *   2. If the call still returns 401 (token revoked Intuit-side, clock skew),
 *      force the local token stale, refresh once, retry once (Layer 2).
 *   3. Second 401 -> throw; the connection is marked 'error' by the token
 *      manager and surfaces in the /settings status panel.
 *
 * `path` is relative to the company endpoint, e.g. "companyinfo/<realmId>".
 */
export async function quickbooksFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { accountingBaseUrl } = getQuickBooksConfig();

  const doFetch = async (accessToken: string, realmId: string) => {
    const url = `${accountingBaseUrl}/v3/company/${realmId}/${path.replace(/^\//, "")}`;
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  };

  const first = await getValidAccessToken();
  let res = await doFetch(first.accessToken, first.realmId);

  if (res.status === 401) {
    await forceExpireAccessToken();
    const retry = await getValidAccessToken();
    res = await doFetch(retry.accessToken, retry.realmId);
  }

  return res;
}

/** quickbooksFetch + JSON parse + non-2xx -> Error (message carries QB fault). */
export async function quickbooksJson<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await quickbooksFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as {
        Fault?: { Error?: Array<{ Message?: string; Detail?: string }> };
      };
      const e = j.Fault?.Error?.[0];
      if (e) detail = [e.Message, e.Detail].filter(Boolean).join(" — ") || detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`QuickBooks API ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as T;
}
