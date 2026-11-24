import "server-only";
import { headers } from "next/headers";

/**
 * The origin DocuSign sends the signer back to after embedded signing.
 *
 * The return page posts its result to window.location.origin, and the wizard
 * only accepts a message from its own origin; /book's CSP only lets the
 * signing iframe navigate to 'self'. So the return URL has to be on the SAME
 * origin as the /book page that asked for it. A fixed NEXT_PUBLIC_SITE_URL
 * sent a Preview's signer to the production domain, where the frame was
 * refused.
 *
 * So the origin is taken from the request's host, but only when that host is
 * on the allowlist:
 *
 *   - the host of NEXT_PUBLIC_SITE_URL (production's own domain)
 *   - VERCEL_URL and VERCEL_BRANCH_URL (set by Vercel per deployment, not by
 *     the visitor)
 *   - localhost / 127.0.0.1 / [::1], any port, only outside production
 *     (NODE_ENV !== "production"; Vercel Preview counts as production)
 *
 * Allowed hosts get https://, except localhost, which gets http://. The
 * request's protocol header is never trusted. Anything else (no header, a
 * host not on the list, a malformed host) falls back to NEXT_PUBLIC_SITE_URL,
 * exactly as before this change.
 */

type Env = Partial<Record<"NEXT_PUBLIC_SITE_URL" | "VERCEL_URL" | "VERCEL_BRANCH_URL" | "NODE_ENV", string>>;

const HOST_RE = /^[a-z0-9.-]+(:[0-9]{1,5})?$|^\[::1\](:[0-9]{1,5})?$/;
const LOCAL_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?$/;

/** Today's origin, unchanged: NEXT_PUBLIC_SITE_URL, else local dev. */
export function fallbackReturnOrigin(env: Env = process.env): string {
  return (env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** "https://a.b/", "a.b", " A.B " -> "a.b" (lower case, host[:port] only). */
function hostOf(v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function resolveReturnOrigin(requestHost: string | null | undefined, env: Env = process.env): string {
  // A proxy may send a list; the first entry is the host the visitor asked for.
  const host = requestHost?.split(",")[0].trim().toLowerCase() ?? "";
  if (!host || !HOST_RE.test(host)) return fallbackReturnOrigin(env);

  if (LOCAL_RE.test(host)) {
    return env.NODE_ENV === "production" ? fallbackReturnOrigin(env) : `http://${host}`;
  }

  const allowed = [hostOf(env.NEXT_PUBLIC_SITE_URL), hostOf(env.VERCEL_URL), hostOf(env.VERCEL_BRANCH_URL)];
  return allowed.includes(host) ? `https://${host}` : fallbackReturnOrigin(env);
}

/**
 * For a server action or route: the allowlisted origin of this request. Reads
 * x-forwarded-host first, then host (the same order Next's server-action
 * origin check uses). Outside a request it falls back.
 */
export function requestReturnOrigin(): string {
  let h: ReturnType<typeof headers>;
  try {
    h = headers();
  } catch {
    return fallbackReturnOrigin();
  }
  return resolveReturnOrigin(h.get("x-forwarded-host") ?? h.get("host"));
}
