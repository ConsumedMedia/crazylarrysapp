import { MAX_WEBHOOK_BODY_BYTES, type QuoWebhookConfig } from "./config";
import { mapQuoEvent, type IngestFields } from "./quo-events";
import { verifyQuoSignature } from "./quo-signature";

/**
 * The Quo webhook decision, separated from Next's Request so it can be tested
 * with plain values. Order matters and is the security contract:
 *
 *   1. flag off                    -> 503, nothing read
 *   2. QUO_WEBHOOK_KEY / QUO_ORG_ID missing -> 503 for every request
 *   3. body over the size limit    -> 413, unread
 *   4. signature / timestamp check -> 401 (nothing parsed before this)
 *   5. parse, map, org check       -> 200 "ignored" for anything we don't store
 *   6. ingest                      -> 200, or 500 so Quo retries
 *
 * `log` is the only thing the route logs. It holds ids, the event type and
 * the outcome — never the body, transcript, summary, phone numbers or secrets.
 */

export interface QuoWebhookRequest {
  rawBody: string;
  contentLength: number | null;
  headers: {
    webhookId: string | null;
    webhookTimestamp: string | null;
    webhookSignature: string | null;
  };
}

export type IngestFn = (callId: string, webhookId: string, fields: IngestFields) => Promise<void>;

export interface QuoWebhookDeps {
  config: QuoWebhookConfig;
  nowSeconds: number;
  ingest: IngestFn;
}

export type QuoWebhookOutcome =
  | "disabled"
  | "not_configured"
  | "too_large"
  | "rejected"
  | "bad_json"
  | "ignored"
  | "stored"
  | "ingest_failed";

export interface QuoWebhookLog {
  outcome: QuoWebhookOutcome;
  reason?: string;
  deliveryId?: string;
  type?: string | null;
  callId?: string;
}

export interface QuoWebhookResult {
  status: number;
  body: Record<string, unknown>;
  log: QuoWebhookLog;
}

export async function handleQuoWebhook(
  req: QuoWebhookRequest,
  deps: QuoWebhookDeps,
): Promise<QuoWebhookResult> {
  const { config } = deps;

  if (!config.enabled) {
    return { status: 503, body: { error: "unavailable" }, log: { outcome: "disabled" } };
  }
  if (!config.key || !config.orgId) {
    const missing = [!config.key && "QUO_WEBHOOK_KEY", !config.orgId && "QUO_ORG_ID"].filter(Boolean);
    return {
      status: 503,
      body: { error: "unavailable" },
      log: { outcome: "not_configured", reason: `missing ${missing.join(", ")}` },
    };
  }

  const size = Math.max(req.contentLength ?? 0, Buffer.byteLength(req.rawBody, "utf8"));
  if (size > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413, body: { error: "too_large" }, log: { outcome: "too_large" } };
  }

  const sig = verifyQuoSignature({
    rawBody: req.rawBody,
    webhookId: req.headers.webhookId,
    webhookTimestamp: req.headers.webhookTimestamp,
    webhookSignature: req.headers.webhookSignature,
    secret: config.key,
    nowSeconds: deps.nowSeconds,
  });
  if (!sig.ok) {
    return { status: 401, body: { error: "unauthorized" }, log: { outcome: "rejected", reason: sig.reason } };
  }
  // Verified, so the header is present.
  const deliveryId = req.headers.webhookId as string;

  let envelope: unknown;
  try {
    envelope = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "bad_json" }, log: { outcome: "bad_json", deliveryId } };
  }

  const mapped = mapQuoEvent(envelope);
  if (mapped.orgId !== config.orgId) {
    // Signed with our key, so it came from Quo — but not for Larry's
    // workspace (or with no workspace at all). Acknowledge so Quo stops
    // retrying; store nothing.
    return {
      status: 200,
      body: { ok: true, ignored: "org_mismatch" },
      log: { outcome: "ignored", reason: "org_mismatch", deliveryId, type: mapped.type },
    };
  }
  if (mapped.kind === "ignore") {
    return {
      status: 200,
      body: { ok: true, ignored: mapped.reason },
      log: { outcome: "ignored", reason: mapped.reason, deliveryId, type: mapped.type },
    };
  }

  try {
    await deps.ingest(mapped.callId, deliveryId, mapped.fields);
  } catch {
    // The error text can echo row values; it is deliberately not logged.
    return {
      status: 500,
      body: { error: "retry" },
      log: { outcome: "ingest_failed", deliveryId, type: mapped.type, callId: mapped.callId },
    };
  }

  return {
    status: 200,
    body: { ok: true },
    log: { outcome: "stored", deliveryId, type: mapped.type, callId: mapped.callId },
  };
}
