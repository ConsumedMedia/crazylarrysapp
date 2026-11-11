/**
 * Unit test — no network, no database. Requests are signed here with a test
 * secret and `ingest` is a fake that captures what would be sent to
 * public.ingest_quo_call_event, so these tests see exactly what would be
 * stored. Payload shapes follow Quo's 2026-03-30 webhook docs; all values are
 * fictional.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { handleQuoWebhook, type QuoWebhookRequest, type QuoWebhookDeps } from "./quo-webhook";
import { mapQuoEvent, type IngestFields } from "./quo-events";
import { REDACTED_CARD } from "./redact";
import { MAX_WEBHOOK_BODY_BYTES, readQuoWebhookConfig } from "./config";

const SECRET = "whsec_" + randomBytes(24).toString("base64");
const ORG = "ORtest123";
const NOW = 1_800_000_000;

const CARD = "4111 1111 1111 1111";
const AMEX = "378282246310005";

const context = {
  orgId: ORG,
  phoneNumberId: "PNyard",
  conversationId: "CN1",
  phoneNumberType: "shared",
  userId: "USlarry",
  contacts: { ids: [], lookupStatus: "none" },
  participants: { workspace: ["+16145550100"], external: ["+16145550142"], resolution: "available" },
};
const envelope = (type: string, resource: object, ctx: object = context) => ({
  id: "EV1",
  apiVersion: "2026-03-30",
  createdAt: "2026-10-28T14:01:00.000Z",
  type,
  data: { resource, context: ctx, links: { quo: null } },
});

const COMPLETED = envelope("call.completed", {
  id: "ACcall1",
  direction: "incoming",
  status: "answered",
  createdAt: "2026-10-28T14:00:00.000Z",
  answeredAt: "2026-10-28T14:00:05.000Z",
  completedAt: "2026-10-28T14:01:00.000Z",
  updatedAt: "2026-10-28T14:01:00.000Z",
  duration: 55,
  hasVoicemail: false,
});
const SUMMARY = envelope("call.summary.completed", {
  callId: "ACcall1",
  processingStatus: "completed",
  summary: ["Caller wants a 20 yard for Friday.", `Read card ${CARD} to pay the deposit.`],
  nextSteps: [`Charge ${AMEX} after delivery`, "Confirm the driveway placement"],
  fromPhoneNumber: null,
  handledByAiAgent: false,
  answeredByUserId: "USlarry",
  jobs: [],
});
const TRANSCRIPT = envelope("call.transcript.completed", {
  callId: "ACcall1",
  createdAt: "2026-10-28T14:00:01.000Z",
  duration: 55,
  processingStatus: "completed",
  dialogue: [
    { userId: "USlarry", identifier: null, content: "Crazy Larry's, how can I help?", start: 0, end: 2 },
    { userId: null, identifier: "+16145550142", content: `Sure, it's ${CARD}, expires 12/29.`, start: 3, end: 8 },
    { userId: null, identifier: "+16145550142", content: `Or use the other one, ${AMEX}.`, start: 9, end: 12 },
  ],
});
const VOICEMAIL = envelope("call.voicemail.completed", {
  id: "ACvm1",
  voicemailId: "VM1",
  callId: "ACcall2",
  direction: "incoming",
  duration: 18,
  from: "+16145550142",
  to: "+16145550100",
  transcript: `Call me back, or just charge ${CARD}.`,
  recordingUrl: "https://recordings.example.invalid/VM1.mp3",
  createdAt: "2026-10-28T15:00:00.000Z",
  updatedAt: "2026-10-28T15:00:10.000Z",
});

function signed(body: unknown, opts: { id?: string; ts?: number; secret?: string } = {}): QuoWebhookRequest {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const id = opts.id ?? "msg_" + randomBytes(6).toString("hex");
  const ts = opts.ts ?? NOW;
  const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return {
    rawBody,
    contentLength: Buffer.byteLength(rawBody),
    headers: { webhookId: id, webhookTimestamp: String(ts), webhookSignature: `v1,${sig}` },
  };
}

let calls: Array<{ callId: string; webhookId: string; fields: IngestFields }>;
let deps: QuoWebhookDeps;
beforeEach(() => {
  calls = [];
  deps = {
    config: { enabled: true, key: SECRET, orgId: ORG },
    nowSeconds: NOW,
    ingest: async (callId, webhookId, fields) => {
      calls.push({ callId, webhookId, fields });
    },
  };
});

describe("handleQuoWebhook — refusals happen before anything is read or stored", () => {
  it("flag off: 503 for every request, even a valid one", async () => {
    const r = await handleQuoWebhook(signed(COMPLETED), { ...deps, config: { ...deps.config, enabled: false } });
    expect(r.status).toBe(503);
    expect(r.log.outcome).toBe("disabled");
    expect(calls).toEqual([]);
  });

  it.each([
    ["QUO_WEBHOOK_KEY", { key: null }],
    ["QUO_ORG_ID", { orgId: null }],
    ["QUO_WEBHOOK_KEY, QUO_ORG_ID", { key: null, orgId: null }],
  ])("flag on but %s missing: 503 for every request", async (missing, over) => {
    const r = await handleQuoWebhook(signed(COMPLETED), { ...deps, config: { ...deps.config, ...over } });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "unavailable" });
    expect(r.log).toEqual({ outcome: "not_configured", reason: `missing ${missing}` });
    expect(calls).toEqual([]);
  });

  it("config reader: unset or blank env counts as missing, and only '1' enables", () => {
    expect(readQuoWebhookConfig({ CL_QUO_WEBHOOK_ENABLED: "1", QUO_WEBHOOK_KEY: "  ", QUO_ORG_ID: "" }))
      .toEqual({ enabled: true, key: null, orgId: null, segments: false });
    expect(readQuoWebhookConfig({ CL_QUO_WEBHOOK_ENABLED: "true" }).enabled).toBe(false);
    expect(readQuoWebhookConfig({}).enabled).toBe(false);
  });

  it("unsigned request: 401", async () => {
    const r = await handleQuoWebhook(
      { rawBody: JSON.stringify(COMPLETED), contentLength: null, headers: { webhookId: null, webhookTimestamp: null, webhookSignature: null } },
      deps,
    );
    expect(r.status).toBe(401);
    expect(r.log).toEqual({ outcome: "rejected", reason: "missing_headers" });
    expect(calls).toEqual([]);
  });

  it("signed with another secret: 401", async () => {
    const r = await handleQuoWebhook(signed(COMPLETED, { secret: "whsec_" + randomBytes(24).toString("base64") }), deps);
    expect(r.status).toBe(401);
    expect(r.log.reason).toBe("bad_signature");
  });

  it("body changed after signing: 401", async () => {
    const req = signed(COMPLETED);
    req.rawBody = req.rawBody.replace('"duration":55', '"duration":5');
    const r = await handleQuoWebhook(req, deps);
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("stale timestamp (replay): 401", async () => {
    const r = await handleQuoWebhook(signed(COMPLETED, { ts: NOW - 301 }), deps);
    expect(r.status).toBe(401);
    expect(r.log.reason).toBe("stale_timestamp");
  });

  it("future timestamp: 401", async () => {
    const r = await handleQuoWebhook(signed(COMPLETED, { ts: NOW + 61 }), deps);
    expect(r.status).toBe(401);
    expect(r.log.reason).toBe("future_timestamp");
  });

  it("oversized body: 413 without verifying or parsing", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    const r = await handleQuoWebhook({ ...signed(COMPLETED), rawBody: big }, deps);
    expect(r.status).toBe(413);
    const byHeader = await handleQuoWebhook({ ...signed(COMPLETED), contentLength: MAX_WEBHOOK_BODY_BYTES + 1 }, deps);
    expect(byHeader.status).toBe(413);
  });

  it("signed but not JSON: 400", async () => {
    const r = await handleQuoWebhook(signed("not json"), deps);
    expect(r.status).toBe(400);
  });
});

describe("handleQuoWebhook — accepted deliveries", () => {
  it("stores call.completed with caller, direction, status, start time and duration", async () => {
    const req = signed(COMPLETED, { id: "msg_completed" });
    const r = await handleQuoWebhook(req, deps);
    expect(r.status).toBe(200);
    expect(calls).toEqual([
      {
        callId: "ACcall1",
        webhookId: "msg_completed",
        fields: {
          caller_number: "+16145550142",
          quo_phone_number_id: "PNyard",
          direction: "incoming",
          call_status: "answered",
          call_started_at: "2026-10-28T14:00:00.000Z",
          duration_seconds: 55,
          has_voicemail: false,
        },
      },
    ]);
    expect(r.log).toEqual({ outcome: "stored", deliveryId: "msg_completed", type: "call.completed", callId: "ACcall1" });
  });

  it("call.missed is stored as an incoming missed call", async () => {
    await handleQuoWebhook(
      signed(envelope("call.missed", { id: "ACmiss", createdAt: "2026-10-28T16:00:00.000Z", updatedAt: "2026-10-28T16:00:30.000Z" })),
      deps,
    );
    expect(calls[0].fields).toMatchObject({ direction: "incoming", call_status: "missed", caller_number: "+16145550142" });
  });

  it("a retried delivery (same webhook-id, same body) sends the same values again — the RPC upsert makes that a no-op", async () => {
    const req = signed(SUMMARY, { id: "msg_retry" });
    await handleQuoWebhook(req, deps);
    await handleQuoWebhook(req, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("summary not completed: no summary fields, so the stored one is kept", async () => {
    await handleQuoWebhook(
      signed(envelope("call.summary.completed", { callId: "ACcall1", processingStatus: "in-progress", summary: null, nextSteps: null, jobs: [] })),
      deps,
    );
    expect(calls[0].fields).not.toHaveProperty("summary");
    expect(calls[0].fields).not.toHaveProperty("next_steps");
  });

  it("participants unavailable: no caller number (unknown, not empty)", async () => {
    const ctx = { ...context, participants: { workspace: [], external: [], resolution: "unavailable" } };
    await handleQuoWebhook(signed(envelope("call.completed", { id: "ACx", direction: "incoming", status: "answered" }, ctx)), deps);
    expect(calls[0].fields).not.toHaveProperty("caller_number");
  });

  it("another workspace's event: 200 so Quo stops retrying, nothing stored", async () => {
    const r = await handleQuoWebhook(signed(envelope("call.completed", { id: "ACx" }, { ...context, orgId: "ORother" })), deps);
    expect(r.status).toBe(200);
    expect(r.log.reason).toBe("org_mismatch");
    expect(calls).toEqual([]);
  });

  it.each([
    ["message.received", envelope("message.received", { id: "AC-message", text: "hi" }), "unhandled_type"],
    ["voicemail with no source call", envelope("call.voicemail.completed", { id: "ACvm", callId: null, transcript: "hi" }), "no_call_id"],
    ["summary with no callId", envelope("call.summary.completed", { processingStatus: "completed", summary: ["x"] }), "no_call_id"],
  ])("%s: 200 ignored, nothing stored", async (_n, body, reason) => {
    const r = await handleQuoWebhook(signed(body), deps);
    expect(r.status).toBe(200);
    expect(r.log.reason).toBe(reason);
    expect(calls).toEqual([]);
  });

  it("database failure: 500 so Quo retries, and the error text is not logged", async () => {
    const r = await handleQuoWebhook(signed(TRANSCRIPT, { id: "msg_fail" }), {
      ...deps,
      ingest: async () => {
        throw new Error(`insert failed: ${CARD}`);
      },
    });
    expect(r.status).toBe(500);
    expect(r.log).toEqual({ outcome: "ingest_failed", deliveryId: "msg_fail", type: "call.transcript.completed", callId: "ACcall1",
      dialogue: { entries: 3, withUserId: 1, withIdentifier: 2, withNeither: 0, emptyDropped: 0 },
    });
  });

  it("the log line never carries call content, numbers or the secret", async () => {
    const logs = [];
    for (const body of [COMPLETED, SUMMARY, TRANSCRIPT, VOICEMAIL]) {
      logs.push((await handleQuoWebhook(signed(body), deps)).log);
    }
    const all = JSON.stringify(logs);
    expect(all).not.toContain("+1614");
    expect(all).not.toContain("4111");
    expect(all).not.toContain("Larry");
    expect(all).not.toContain("expires");
    expect(all).not.toContain(SECRET);
  });
});

describe("redaction happens before storage — transcript, summary, next steps, dialogue JSON, voicemail", () => {
  it("nothing card-like reaches the ingest call, and every field that had one is marked", async () => {
    for (const body of [SUMMARY, TRANSCRIPT, VOICEMAIL]) {
      const r = await handleQuoWebhook(signed(body), deps);
      expect(r.status).toBe(200);
    }
    const [summary, transcript, voicemail] = calls.map((c) => c.fields);

    // Everything handed to the RPC, serialized exactly as the route sends it.
    const stored = JSON.stringify(calls);
    expect(stored).not.toMatch(/\d(?:[ -]?\d){12,18}/);
    expect(stored).not.toContain("4111");
    expect(stored).not.toContain("3782");

    expect(summary.summary).toBe(`Caller wants a 20 yard for Friday.\nRead card ${REDACTED_CARD} to pay the deposit.`);
    expect(summary.next_steps).toEqual([`Charge ${REDACTED_CARD} after delivery`, "Confirm the driveway placement"]);

    expect(transcript.transcript_dialogue).toEqual([
      { speaker: "staff", content: "Crazy Larry's, how can I help?", start: 0, end: 2, user_id: "USlarry", has_identifier: false },
      { speaker: "caller", content: `Sure, it's ${REDACTED_CARD}, expires 12/29.`, start: 3, end: 8, user_id: null, has_identifier: true },
      { speaker: "caller", content: `Or use the other one, ${REDACTED_CARD}.`, start: 9, end: 12, user_id: null, has_identifier: true },
    ]);
    expect(transcript.transcript).toBe(
      [
        "Staff: Crazy Larry's, how can I help?",
        `Caller: Sure, it's ${REDACTED_CARD}, expires 12/29.`,
        `Caller: Or use the other one, ${REDACTED_CARD}.`,
      ].join("\n"),
    );

    expect(voicemail.voicemail_transcript).toBe(`Call me back, or just charge ${REDACTED_CARD}.`);
    expect(voicemail.has_voicemail).toBe(true);

    // Phone numbers are not card-like and survive.
    expect(transcript.caller_number).toBe("+16145550142");
  });

  it("the mapper itself redacts (the handler adds no unredacted path around it)", () => {
    const m = mapQuoEvent(TRANSCRIPT);
    expect(m.kind).toBe("ingest");
    expect(JSON.stringify(m)).not.toContain("4111");
  });
});

describe("transcript speakers, timing and delivery shape", () => {
  const withDialogue = (dialogue: unknown) =>
    envelope("call.transcript.completed", {
      callId: "ACcall2",
      createdAt: "2026-11-04T14:00:01.000Z",
      duration: 46,
      processingStatus: "completed",
      dialogue,
    });

  it("staff = userId, caller = identifier only, unknown = neither; start/end kept as sent; no identifier stored", () => {
    const m = mapQuoEvent(
      withDialogue([
        { userId: "USlarry", identifier: "+16145550100", content: "Staff on a device", start: 0.25, end: 1.5 },
        { userId: null, identifier: "+16145550142", content: "Caller line", start: 9.4, end: 9.9 },
        { userId: null, identifier: null, content: "Nobody tagged", start: 9.6, end: null },
        { content: "No keys at all" },
      ]),
    );
    expect(m.kind).toBe("ingest");
    if (m.kind !== "ingest") return;
    expect(m.fields.transcript_dialogue).toEqual([
      { speaker: "staff", content: "Staff on a device", start: 0.25, end: 1.5, user_id: "USlarry", has_identifier: true },
      { speaker: "caller", content: "Caller line", start: 9.4, end: 9.9, user_id: null, has_identifier: true },
      { speaker: "unknown", content: "Nobody tagged", start: 9.6, end: null, user_id: null, has_identifier: false },
      { speaker: "unknown", content: "No keys at all", start: null, end: null, user_id: null, has_identifier: false },
    ]);
    expect(m.fields.transcript).toBe(
      ["Staff: Staff on a device", "Caller: Caller line", "Unknown: Nobody tagged", "Unknown: No keys at all"].join("\n"),
    );
    expect(JSON.stringify(m.fields.transcript_dialogue)).not.toContain("+1614");
  });

  it("passes repeated lines through one for one (no dedupe, no merge)", () => {
    const same = { userId: null, identifier: "+16145550142", content: "Hello?", start: 9, end: 9.5 };
    const m = mapQuoEvent(withDialogue([same, same, same]));
    if (m.kind !== "ingest") throw new Error("expected ingest");
    expect(m.fields.transcript_dialogue).toHaveLength(3);
  });

  it("logs the dialogue shape as counts only", async () => {
    const r = await handleQuoWebhook(
      signed(
        withDialogue([
          { userId: "USlarry", identifier: null, content: "Hi", start: 0, end: 1 },
          { userId: null, identifier: "+16145550142", content: "Card 4111 1111 1111 1111", start: 2, end: 3 },
          { userId: null, identifier: null, content: "?", start: 4, end: 5 },
          { userId: null, identifier: "+16145550142", content: "  ", start: 6, end: 7 },
        ]),
      ),
      deps,
    );
    expect(r.status).toBe(200);
    expect(r.log.dialogue).toEqual({ entries: 4, withUserId: 1, withIdentifier: 2, withNeither: 1, emptyDropped: 1 });
    const line = JSON.stringify(r.log);
    expect(line).not.toContain("+1614");
    expect(line).not.toContain("4111");
    expect(line).not.toContain("Hi");
  });

  it("non-transcript events carry no dialogue shape", async () => {
    const r = await handleQuoWebhook(signed(COMPLETED), deps);
    expect(r.log.dialogue).toBeUndefined();
  });
});
