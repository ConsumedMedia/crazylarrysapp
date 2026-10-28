import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Quo webhook signature check (API version 2026-03-30, Standard Webhooks /
 * Svix scheme):
 *
 *   webhook-signature = space-separated "v1,<base64>" entries, where
 *   <base64> = base64(HMAC-SHA256(key, `${webhook-id}.${webhook-timestamp}.${rawBody}`))
 *   key      = base64-decoded secret after stripping the "whsec_" prefix
 *
 * Must run on the exact raw body bytes, before any JSON parsing. Pure: no
 * env, no clock (the caller passes `nowSeconds`), never throws.
 */

/** Oldest accepted signing time, relative to now (Quo's docs: 5 minutes). */
export const MAX_AGE_SECONDS = 5 * 60;
/** A signing time ahead of our clock is accepted only within this much skew. */
export const MAX_FUTURE_SKEW_SECONDS = 60;

export type SignatureFailure =
  | "missing_headers"
  | "bad_secret"
  | "bad_timestamp"
  | "stale_timestamp"
  | "future_timestamp"
  | "bad_signature";

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

export interface SignatureInput {
  rawBody: string;
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
  /** The whsec_... value exactly as Quo returned it. */
  secret: string;
  nowSeconds: number;
}

function secretBytes(secret: string): Buffer | null {
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, "base64");
  return bytes.length > 0 ? bytes : null;
}

export function verifyQuoSignature(input: SignatureInput): SignatureResult {
  const { rawBody, webhookId, webhookTimestamp, webhookSignature, secret, nowSeconds } = input;
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: "missing_headers" };
  }

  const key = secret ? secretBytes(secret) : null;
  if (!key) return { ok: false, reason: "bad_secret" };

  if (!/^\d{1,12}$/.test(webhookTimestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(webhookTimestamp);
  if (nowSeconds - ts > MAX_AGE_SECONDS) return { ok: false, reason: "stale_timestamp" };
  if (ts - nowSeconds > MAX_FUTURE_SKEW_SECONDS) return { ok: false, reason: "future_timestamp" };

  const expected = Buffer.from(
    createHmac("sha256", key)
      .update(`${webhookId}.${webhookTimestamp}.${rawBody}`)
      .digest("base64"),
  );

  const matched = webhookSignature
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const comma = entry.indexOf(",");
      if (comma < 0 || entry.slice(0, comma) !== "v1") return false;
      const given = Buffer.from(entry.slice(comma + 1));
      return given.length === expected.length && timingSafeEqual(given, expected);
    });

  return matched ? { ok: true } : { ok: false, reason: "bad_signature" };
}
