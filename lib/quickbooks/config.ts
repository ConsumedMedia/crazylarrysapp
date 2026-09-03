import "server-only";

/**
 * QuickBooks / Intuit OAuth + API configuration.
 *
 * Every value here is read from server-only env vars (no NEXT_PUBLIC_ prefix),
 * so none of it — the client secret least of all — is ever bundled into browser
 * JS. This module must never be imported by a Client Component.
 */

export type QuickBooksEnvironment = "sandbox" | "production";

export const QB_SCOPES = [
  "com.intuit.quickbooks.accounting",
  "com.intuit.quickbooks.payment",
].join(" ");

// OAuth endpoints are identical for sandbox and production.
export const QB_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QB_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QB_REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QuickBooksEnvironment;
  /** Base host for Accounting + Payments API calls, environment-dependent. */
  accountingBaseUrl: string;
  paymentsBaseUrl: string;
  /** Symmetric key for pgp_sym_encrypt of the refresh token at rest. */
  tokenEncKey: string;
  /** Direct Postgres connection string for the token manager. */
  databaseUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is not set — QuickBooks integration unavailable`);
  }
  return v.trim();
}

let cached: QuickBooksConfig | null = null;

export function getQuickBooksConfig(): QuickBooksConfig {
  if (cached) return cached;

  const environment = (process.env.QUICKBOOKS_ENVIRONMENT ??
    "sandbox") as QuickBooksEnvironment;
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      `QUICKBOOKS_ENVIRONMENT must be "sandbox" or "production", got "${environment}"`,
    );
  }

  const accountingBaseUrl =
    environment === "production"
      ? "https://quickbooks.api.intuit.com"
      : "https://sandbox-quickbooks.api.intuit.com";
  const paymentsBaseUrl =
    environment === "production"
      ? "https://api.intuit.com"
      : "https://sandbox.api.intuit.com";

  cached = {
    clientId: required("QUICKBOOKS_CLIENT_ID"),
    clientSecret: required("QUICKBOOKS_CLIENT_SECRET"),
    redirectUri: required("QUICKBOOKS_REDIRECT_URI"),
    environment,
    accountingBaseUrl,
    paymentsBaseUrl,
    tokenEncKey: required("QUICKBOOKS_TOKEN_ENC_KEY"),
    databaseUrl: required("DATABASE_URL"),
  };
  return cached;
}

const REQUIRED_ENV = [
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_REDIRECT_URI",
  "QUICKBOOKS_ENVIRONMENT",
  "QUICKBOOKS_TOKEN_ENC_KEY",
  "DATABASE_URL",
] as const;

/** Names of the required env vars that are missing or empty. Never logs values. */
export function missingQuickBooksEnv(): string[] {
  return REQUIRED_ENV.filter((name) => {
    const v = process.env[name];
    return !v || !v.trim();
  });
}

/** True when every QuickBooks env var is present — used to hide UI when not. */
export function quickBooksConfigured(): boolean {
  const missing = missingQuickBooksEnv();
  if (missing.length > 0) {
    // TEMP DEBUG — remove once the connect flow is confirmed working.
    console.warn(
      `[quickbooks/config] not configured — missing/empty: ${missing.join(", ")}`,
    );
    return false;
  }
  try {
    getQuickBooksConfig();
    return true;
  } catch (e) {
    console.warn(`[quickbooks/config] getQuickBooksConfig threw: ${(e as Error).message}`);
    return false;
  }
}

/** HTTP Basic header for the token endpoint. Never logged, never returned. */
export function basicAuthHeader(): string {
  const { clientId, clientSecret } = getQuickBooksConfig();
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}
