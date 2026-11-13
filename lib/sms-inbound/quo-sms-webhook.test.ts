/**
 * The Quo SMS webhook decision, with plain values. Signatures are real
 * HMAC-SHA256 over a throwaway test key; nothing reaches Quo or a database
 * (record is a spy, fetch is stubbed and asserted unused).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { handleQuoSmsWebhook, type RecordFn, type QuoSmsWebhookRequest } from "./quo-sms-webhook";
import type { QuoSmsWebhookConfig } from "./config";

const SECRET_BYTES = Buffer.from("test-only-signing-key-for-b4-tests");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const ORG = "ORtestorg123";
const YARD = "PNXYakN6nP";
const NOW = 1_763_046_000; // fixed clock
const SENDER = "+16145550143";

const config = (over: Partial<QuoSmsWebhookConfig> = {}): QuoSmsWebhookConfig => ({
  enabled: true,
  key: SECRET,
  orgId: ORG,
  yardPhoneNumberId: YARD,
  ...over,
});

function envelope(over: { type?: string; text?: unknown; direction?: string; orgId?: string; phoneNumberId?: string | null; sender?: string | null; id?: string | null; createdAt?: string } = {}) {
  return {
    id: "EV1",
    apiVersion: "2026-03-30",
    createdAt: "2026-11-13T15:00:05.000Z",
    type: over.type ?? "message.received",
    data: {
      resource: {
        id: over.id === undefined ? "AC_msg_1" : over.id,
        direction: over.direction ?? "incoming",
        text: over.text === undefined ? "STOP" : over.text,
        media: [],
        status: "received",
        createdAt: over.createdAt ?? "2026-11-13T15:00:00.000Z",
      },
      context: {
        orgId: over.orgId ?? ORG,
        phoneNumberId: over.phoneNumberId === undefined ? YARD : over.phoneNumberId,
        conversationId: "CN1",
        userId: null,
        contacts: { ids: [], lookupStatus: "none" },
        senderIdentifier: over.sender === undefined ? SENDER : over.sender,
        recipientIdentifiers: ["+16145550100"],
      },
      links: { quo: null },
    },
  };
}

function signed(body: unknown, opts: { id?: string; ts?: number; key?: Buffer; raw?: string } = {}): QuoSmsWebhookRequest {
  const rawBody = opts.raw ?? JSON.stringify(body);
  const id = opts.id ?? "msg_delivery_1";
  const ts = String(opts.ts ?? NOW);
  const sig = createHmac("sha256", opts.key ?? SECRET_BYTES).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return { rawBody, contentLength: Buffer.byteLength(rawBody), headers: { webhookId: id, webhookTimestamp: ts, webhookSignature: `v1,${sig}` } };
}

let record: ReturnType<typeof vi.fn<RecordFn>>;
const fetchMock = vi.fn();
beforeEach(() => {
  record = vi.fn<RecordFn>(async () => ({ status: "recorded", matched: 1, needs_review: false, has_number: true }));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled(); // never Quo, never anything
  vi.unstubAllGlobals();
});
const run = (req: QuoSmsWebhookRequest, cfg = config()) => handleQuoSmsWebhook(req, { config: cfg, nowSeconds: NOW, record });

describe("order: flag, config, size, signature before anything is parsed", () => {
  it("flag off: 503, record never called, nothing parsed", async () => {
    const r = await run({ rawBody: "not json", contentLength: 8, headers: { webhookId: null, webhookTimestamp: null, webhookSignature: null } }, config({ enabled: false }));
    expect(r).toMatchObject({ status: 503, log: { outcome: "disabled" } });
    expect(record).not.toHaveBeenCalled();
  });

  it("key or org missing: 503 naming the variable", async () => {
    expect((await run(signed(envelope()), config({ key: null }))).log).toEqual({ outcome: "not_configured", reason: "missing QUO_SMS_WEBHOOK_KEY" });
    expect((await run(signed(envelope()), config({ orgId: null }))).log).toEqual({ outcome: "not_configured", reason: "missing QUO_ORG_ID" });
  });

  it("too large: 413 before the signature is checked", async () => {
    const req = signed(envelope());
    const r = await run({ ...req, contentLength: 2_000_000, headers: { webhookId: null, webhookTimestamp: null, webhookSignature: null } });
    expect(r).toMatchObject({ status: 413, log: { outcome: "too_large" } });
  });

  it.each([
    ["wrong key", { key: Buffer.from("another-key") }, "bad_signature"],
    ["stale timestamp", { ts: NOW - 301 }, "stale_timestamp"],
    ["future timestamp", { ts: NOW + 61 }, "future_timestamp"],
  ] as const)("%s: 401, not parsed, not recorded", async (_l, opts, reason) => {
    const r = await run(signed(envelope(), opts));
    expect(r).toMatchObject({ status: 401, log: { outcome: "rejected", reason } });
    expect(record).not.toHaveBeenCalled();
  });

  it("a body changed after signing: 401", async () => {
    const req = signed(envelope());
    const r = await run({ ...req, rawBody: req.rawBody.replace("STOP", "HELP") });
    expect(r.status).toBe(401);
  });

  it("missing headers: 401", async () => {
    const req = signed(envelope());
    expect((await run({ ...req, headers: { ...req.headers, webhookSignature: null } })).log.reason).toBe("missing_headers");
  });

  it("signed but not JSON: 400", async () => {
    const r = await run(signed(null, { raw: "{not json" }));
    expect(r).toMatchObject({ status: 400, log: { outcome: "bad_json", deliveryId: "msg_delivery_1" } });
  });
});

describe("what is ignored (200, nothing stored)", () => {
  it.each([
    ["another workspace (Quo's test events)", envelope({ orgId: "ORsampleorg" }), "org_mismatch"],
    ["a call event", envelope({ type: "call.completed" }), "unhandled_type"],
    ["message.delivered", envelope({ type: "message.delivered" }), "unhandled_type"],
    ["an outgoing message", envelope({ direction: "outgoing" }), "not_incoming"],
    ["another line", envelope({ phoneNumberId: "PNotherline" }), "other_line"],
    ["no line", envelope({ phoneNumberId: null }), "other_line"],
    ["no message id", envelope({ id: null }), "malformed"],
    ["no sender", envelope({ sender: null }), "no_sender"],
    ["not a keyword", envelope({ text: "Can you deliver Friday?" }), "not_keyword"],
    ["HELP", envelope({ text: "HELP" }), "not_keyword"],
    ["media only (no text)", envelope({ text: null }), "not_keyword"],
    ["END inside directions", envelope({ text: "at the end of the driveway" }), "not_keyword"],
  ])("%s", async (_l, env, reason) => {
    const r = await run(signed(env));
    expect(r).toMatchObject({ status: 200, body: { ok: true, ignored: reason }, log: { outcome: "ignored", reason } });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("what is recorded", () => {
  it("STOP: opt_out with the message id, delivery id, sender and Quo's createdAt", async () => {
    const r = await run(signed(envelope({ text: "Stop." })));
    expect(r).toMatchObject({ status: 200, body: { ok: true }, log: { outcome: "recorded", kind: "opt_out", keyword: "STOP", matched: 1, needsReview: false } });
    expect(record).toHaveBeenCalledWith({
      messageId: "AC_msg_1",
      webhookId: "msg_delivery_1",
      sender: SENDER,
      kind: "opt_out",
      keyword: "STOP",
      receivedAt: "2026-11-13T15:00:00.000Z",
      reviewText: null,
    });
  });

  it("CANCEL: opt_out, no text sent to the database", async () => {
    await run(signed(envelope({ text: "cancel" })));
    expect(record.mock.calls[0][0]).toMatchObject({ kind: "opt_out", keyword: "CANCEL", reviewText: null });
  });

  it("START: opt_in", async () => {
    await run(signed(envelope({ text: "START" })));
    expect(record.mock.calls[0][0]).toMatchObject({ kind: "opt_in", keyword: "START", reviewText: null });
  });

  it("a longer message: review, with the text (card numbers redacted, at most 500 characters)", async () => {
    const text = `please stop, my card 4111 1111 1111 1111 was charged ${"x".repeat(600)}`;
    await run(signed(envelope({ text })));
    const a = record.mock.calls[0][0];
    expect(a).toMatchObject({ kind: "review", keyword: "STOP" });
    expect(a.reviewText).not.toContain("4111 1111 1111 1111");
    expect(a.reviewText!.length).toBeLessThanOrEqual(500);
  });

  it("an unparseable resource createdAt falls back to the envelope's, then the clock", async () => {
    await run(signed(envelope({ createdAt: "not a date" })));
    expect(record.mock.calls[0][0].receivedAt).toBe("2026-11-13T15:00:05.000Z");
  });

  it("a duplicate (same message again): 200 duplicate", async () => {
    record.mockResolvedValueOnce({ status: "duplicate" });
    const r = await run(signed(envelope()));
    expect(r).toMatchObject({ status: 200, body: { ok: true, duplicate: true }, log: { outcome: "duplicate" } });
  });

  it("the database fails: 500 so Quo retries, and the error text is not logged", async () => {
    record.mockRejectedValueOnce(new Error("value (+16145550143) violates something"));
    const r = await run(signed(envelope()));
    expect(r).toMatchObject({ status: 500, body: { error: "retry" }, log: { outcome: "record_failed" } });
    expect(JSON.stringify(r.log)).not.toContain("6145550143");
  });
});

describe("the log never holds the number or the text", () => {
  it.each(["STOP", "please stop texting me 614-555-0143", "START", "Can you deliver Friday?"])("%j", async (text) => {
    for (const env of [envelope({ text }), envelope({ text, orgId: "ORother" }), envelope({ text, phoneNumberId: "PNother" })]) {
      const r = await run(signed(env));
      const log = JSON.stringify(r.log) + JSON.stringify(r.body);
      expect(log).not.toContain("6145550143");
      expect(log).not.toContain("texting");
      expect(log).not.toContain("Friday");
    }
  });
});
