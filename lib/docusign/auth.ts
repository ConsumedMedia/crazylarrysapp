import "server-only";
import { createSign } from "node:crypto";
import { getDocusignConfig } from "./config";

/**
 * JWT Grant (service integration): sign an RS256 assertion with the app's
 * private key, exchange it at /oauth/token for an access token that
 * impersonates DOCUSIGN_USER_ID. No SDK — same approach as the QuickBooks
 * OAuth layer.
 *
 * Unlike QuickBooks there's no refresh token to rotate or persist: a new JWT
 * can always be minted, so an in-memory cache per server instance is enough.
 * Concurrent callers share one in-flight request.
 */

const SCOPES = "signature impersonation";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cachedToken: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function buildJwtAssertion(nowSec = Math.floor(Date.now() / 1000)): string {
  const cfg = getDocusignConfig();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: cfg.integrationKey,
      sub: cfg.userId,
      aud: cfg.authHost,
      iat: nowSec,
      exp: nowSec + 3600,
      scope: SCOPES,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(cfg.privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

export class DocusignAuthError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DocusignAuthError";
    this.code = code;
  }
}

async function requestToken(): Promise<string> {
  const cfg = getDocusignConfig();
  const res = await fetch(`https://${cfg.authHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildJwtAssertion(),
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    // error codes (consent_required, invalid_grant, ...) are not secret
    throw new DocusignAuthError(
      `DocuSign token request failed (${res.status}): ${body.error ?? "unknown"}${body.error_description ? ` — ${body.error_description}` : ""}`,
      body.error ?? `http_${res.status}`,
    );
  }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

/** A valid access token, reusing the cached one until 5 minutes before expiry. */
export async function getDocusignAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cachedToken.value;
  }
  if (!inflight) {
    inflight = requestToken().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Drop the cached token (after a 401). */
export function forgetDocusignAccessToken(): void {
  cachedToken = null;
}

/** Test/diagnostic helper: expiry of the cached token, never the token itself. */
export function cachedDocusignTokenExpiresAt(): number | null {
  return cachedToken?.expiresAt ?? null;
}
