import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/call-log/config";
import { verifyQuoSignature } from "@/lib/call-log/quo-signature";
import { redactCardNumbers } from "@/lib/call-log/redact";
import { REVIEW_TEXT_MAX, type QuoSmsWebhookConfig } from "./config";
import { classifyInbound, type InboundKeyword, type InboundKind } from "./keywords";

/**
 * The Quo SMS webhook decision (Plan B.4), separate from Next's Request so it
 * can be tested with plain values. Order is the security contract, the same as
 * the call webhook's:
 *
 *   1. flag off (CL_QUO_SMS_WEBHOOK_ENABLED)        -> 503, nothing read
 *   2. QUO_SMS_WEBHOOK_KEY / QUO_ORG_ID missing      -> 503 for every request
 *   3. body over the size limit                      -> 413, unread
 *   4. signature / timestamp check                   -> 401 (nothing parsed before this)
 *   5. parse; org, event type, direction, yard line,
 *      message id, sender, keyword                   -> 200 "ignored" (nothing stored)
 *   6. record_sms_inbound                            -> 200, or 500 so Quo retries
 *
 * Only keyword texts reach the database. `log` never holds the sender's number
 * or the message text.
 */

export interface QuoSmsWebhookRequest {
  rawBody: string;
  contentLength: number | null;
  headers: { webhookId: string | null; webhookTimestamp: string | null; webhookSignature: string | null };
}

export interface RecordArgs {
  messageId: string;
  webhookId: string;
  sender: string;
  kind: InboundKind;
  keyword: InboundKeyword;
  receivedAt: string;
  /** Review messages only: the text, card numbers redacted, at most 500 characters. */
  reviewText: string | null;
}

export interface RecordResult {
  status: "recorded" | "duplicate";
  matched?: number;
  needs_review?: boolean;
  has_number?: boolean;
}

export type RecordFn = (args: RecordArgs) => Promise<RecordResult>;

export interface QuoSmsWebhookDeps {
  config: QuoSmsWebhookConfig;
  nowSeconds: number;
  record: RecordFn;
}

export type QuoSmsWebhookOutcome =
  | "disabled"
  | "not_configured"
  | "too_large"
  | "rejected"
  | "bad_json"
  | "ignored"
  | "recorded"
  | "duplicate"
  | "record_failed";

export type IgnoreReason =
  | "org_mismatch"
  | "unhandled_type"
  | "not_incoming"
  | "other_line"
  | "malformed"
  | "no_sender"
  | "not_keyword";

export interface QuoSmsWebhookLog {
  outcome: QuoSmsWebhookOutcome;
  reason?: string;
  deliveryId?: string;
  type?: string | null;
  messageId?: string;
  kind?: InboundKind;
  keyword?: InboundKeyword;
  matched?: number;
  needsReview?: boolean;
}

export interface QuoSmsWebhookResult {
  status: number;
  body: Record<string, unknown>;
  log: QuoSmsWebhookLog;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function validIso(v: unknown): string | null {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null;
}

export async function handleQuoSmsWebhook(req: QuoSmsWebhookRequest, deps: QuoSmsWebhookDeps): Promise<QuoSmsWebhookResult> {
  const { config } = deps;

  if (!config.enabled) {
    return { status: 503, body: { error: "unavailable" }, log: { outcome: "disabled" } };
  }
  if (!config.key || !config.orgId) {
    const missing = [!config.key && "QUO_SMS_WEBHOOK_KEY", !config.orgId && "QUO_ORG_ID"].filter(Boolean);
    return { status: 503, body: { error: "unavailable" }, log: { outcome: "not_configured", reason: `missing ${missing.join(", ")}` } };
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
  const deliveryId = req.headers.webhookId as string;

  let envelope: unknown;
  try {
    envelope = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "bad_json" }, log: { outcome: "bad_json", deliveryId } };
  }

  const env = isObj(envelope) ? envelope : {};
  const type = str(env.type);
  const data = isObj(env.data) ? env.data : {};
  const context = isObj(data.context) ? data.context : {};
  const resource = isObj(data.resource) ? data.resource : {};
  const ignore = (reason: IgnoreReason, extra: Partial<QuoSmsWebhookLog> = {}): QuoSmsWebhookResult => ({
    status: 200,
    body: { ok: true, ignored: reason },
    log: { outcome: "ignored", reason, deliveryId, type, ...extra },
  });

  // Signed with our key, so it came from Quo; anything not for Larry's
  // workspace, not an incoming text on the yard line, or not a keyword is
  // acknowledged (so Quo stops retrying) and never stored.
  if (str(context.orgId) !== config.orgId) return ignore("org_mismatch");
  if (type !== "message.received") return ignore("unhandled_type");
  if (resource.direction !== "incoming") return ignore("not_incoming");
  if (str(context.phoneNumberId) !== config.yardPhoneNumberId) return ignore("other_line");
  const messageId = str(resource.id);
  if (!messageId) return ignore("malformed");
  const sender = str(context.senderIdentifier);
  if (!sender) return ignore("no_sender", { messageId });

  const text = typeof resource.text === "string" ? resource.text : "";
  const classified = classifyInbound(text);
  if (!classified) return ignore("not_keyword", { messageId });

  const receivedAt = validIso(resource.createdAt) ?? validIso(env.createdAt) ?? new Date(deps.nowSeconds * 1000).toISOString();
  const reviewText = classified.kind === "review" ? redactCardNumbers(text).slice(0, REVIEW_TEXT_MAX) : null;
  const ids = { deliveryId, type, messageId, kind: classified.kind, keyword: classified.keyword };

  let result: RecordResult;
  try {
    result = await deps.record({
      messageId,
      webhookId: deliveryId,
      sender,
      kind: classified.kind,
      keyword: classified.keyword,
      receivedAt,
      reviewText,
    });
  } catch {
    // The error text can echo row values; it is deliberately not logged.
    return { status: 500, body: { error: "retry" }, log: { outcome: "record_failed", ...ids } };
  }

  if (result.status === "duplicate") {
    return { status: 200, body: { ok: true, duplicate: true }, log: { outcome: "duplicate", ...ids } };
  }
  return {
    status: 200,
    body: { ok: true },
    log: { outcome: "recorded", ...ids, matched: result.matched ?? 0, needsReview: result.needs_review === true },
  };
}
