/**
 * Unit test: CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED in the webhook mapper. No
 * network, no database; requests are signed here with a test secret and the
 * ingest call is a fake. Values are fictional.
 */
import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { mapQuoEvent, type IngestFields } from "./quo-events";
import { handleQuoWebhook } from "./quo-webhook";
import { readQuoWebhookConfig } from "./config";
import { REDACTED_CARD } from "./redact";

const SECRET = "whsec_" + randomBytes(24).toString("base64");
const ORG = "ORtest123";
const NOW = 1_800_000_000;
const CARD = "4111 1111 1111 1111";

const transcript = (dialogue: unknown) => ({
  id: "EV1",
  apiVersion: "2026-03-30",
  type: "call.transcript.completed",
  data: {
    resource: { callId: "ACcall1", createdAt: "2026-11-09T14:01:30.000Z", duration: 55, processingStatus: "completed", dialogue },
    context: { orgId: ORG, participants: { external: ["+16145550142"], resolution: "available" } },
  },
});
const DIALOGUE = [
  { userId: "USlarry", identifier: null, content: "Crazy Larry's", start: 0, end: 2 },
  { userId: null, identifier: "+16145550142", content: `It's ${CARD}`, start: 3, end: 8 },
];

function signed(body: unknown) {
  const rawBody = JSON.stringify(body);
  const id = "msg_" + randomBytes(6).toString("hex");
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${NOW}.${rawBody}`).digest("base64");
  return {
    rawBody,
    contentLength: Buffer.byteLength(rawBody),
    headers: { webhookId: id, webhookTimestamp: String(NOW), webhookSignature: `v1,${sig}` },
  };
}

async function deliver(env: Record<string, string | undefined>) {
  const sent: IngestFields[] = [];
  const config = { ...readQuoWebhookConfig({ CL_QUO_WEBHOOK_ENABLED: "1", QUO_WEBHOOK_KEY: SECRET, QUO_ORG_ID: ORG, ...env }) };
  const r = await handleQuoWebhook(signed(transcript(DIALOGUE)), {
    config,
    nowSeconds: NOW,
    ingest: async (_id, _wh, fields) => void sent.push(fields),
  });
  return { r, sent };
}

describe("segments flag in the webhook mapper", () => {
  it("off (unset, or anything but exactly '1'): transcript and dialogue exactly as before, no segment", async () => {
    for (const v of [undefined, "", "0", "true", " 1", "1 ", "yes"]) {
      const { r, sent } = await deliver({ CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED: v });
      expect(r.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].transcript_segment).toBeUndefined();
      expect(sent[0].transcript).toBe(`Staff: Crazy Larry's\nCaller: It's ${REDACTED_CARD}`);
      expect(sent[0]).toEqual(mapQuoEvent(transcript(DIALOGUE)).kind === "ingest" ? (mapQuoEvent(transcript(DIALOGUE)) as { fields: IngestFields }).fields : null);
    }
  });

  it("on (exactly '1'): one segment with the same redacted lines, order_at from createdAt; no transcript or dialogue keys", async () => {
    const { sent } = await deliver({ CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED: "1" });
    const off = mapQuoEvent(transcript(DIALOGUE));
    if (off.kind !== "ingest") throw new Error("expected ingest");
    expect(sent[0].transcript).toBeUndefined();
    expect(sent[0].transcript_dialogue).toBeUndefined();
    expect(sent[0].transcript_segment).toEqual({
      lines: off.fields.transcript_dialogue,
      order_at: "2026-11-09T14:01:30.000Z",
      duration: 55,
    });
    expect(JSON.stringify(sent[0])).not.toContain("4111");
    // Everything else the event carries is unchanged.
    const without = (o: object, drop: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));
    expect(without(sent[0], ["transcript_segment"])).toEqual(without(off.fields, ["transcript", "transcript_dialogue"]));
  });

  it("on: a transcript still processing, or with no non-empty line, sends no segment", () => {
    const pending = mapQuoEvent(
      { ...transcript(DIALOGUE), data: { ...transcript(DIALOGUE).data, resource: { callId: "ACcall1", processingStatus: "in-progress", dialogue: null } } },
      { segments: true },
    );
    const empty = mapQuoEvent(transcript([{ userId: null, identifier: "+1", content: "  " }]), { segments: true });
    for (const m of [pending, empty]) {
      if (m.kind !== "ingest") throw new Error("expected ingest");
      expect(m.fields.transcript_segment).toBeUndefined();
      expect(m.fields.transcript).toBeUndefined();
    }
  });

  it("on: other event types are unaffected", () => {
    const completed = {
      type: "call.completed",
      data: { resource: { id: "ACcall1", direction: "incoming", status: "answered", createdAt: "2026-11-09T14:00:00Z", duration: 55 }, context: { orgId: ORG } },
    };
    expect(mapQuoEvent(completed, { segments: true })).toEqual(mapQuoEvent(completed));
  });

  it("the config reader turns segments on only for exactly '1'", () => {
    expect(readQuoWebhookConfig({}).segments).toBe(false);
    expect(readQuoWebhookConfig({ CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED: "true" }).segments).toBe(false);
    expect(readQuoWebhookConfig({ CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED: "1" }).segments).toBe(true);
  });
});
