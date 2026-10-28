/**
 * Unit test — pure crypto, no network, no database.
 *
 * The first case is the published Standard Webhooks / Svix test vector (the
 * scheme Quo's docs say they use), so it checks our HMAC construction against
 * an outside reference, not against itself.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyQuoSignature,
  MAX_AGE_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  type SignatureInput,
} from "./quo-signature";

const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  ts: 1614265330,
  body: '{"test": 2432232314}',
  sig: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

function input(over: Partial<SignatureInput> = {}): SignatureInput {
  return {
    rawBody: VECTOR.body,
    webhookId: VECTOR.id,
    webhookTimestamp: String(VECTOR.ts),
    webhookSignature: VECTOR.sig,
    secret: VECTOR.secret,
    nowSeconds: VECTOR.ts,
    ...over,
  };
}

/** Sign like Quo does, for cases the fixed vector can't cover. */
function sign(secret: string, id: string, ts: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

describe("verifyQuoSignature", () => {
  it("accepts the published reference vector", () => {
    expect(verifyQuoSignature(input())).toEqual({ ok: true });
  });

  it("accepts a secret given without the whsec_ prefix", () => {
    expect(verifyQuoSignature(input({ secret: VECTOR.secret.slice(6) }))).toEqual({ ok: true });
  });

  it("accepts when any one of several space-separated entries matches", () => {
    const sig = `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${VECTOR.sig} v2,ignored`;
    expect(verifyQuoSignature(input({ webhookSignature: sig }))).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    expect(verifyQuoSignature(input({ rawBody: '{"test": 2432232315}' }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects re-serialized JSON (verification must use the raw bytes)", () => {
    const reparsed = JSON.stringify(JSON.parse(VECTOR.body)); // drops the space
    expect(verifyQuoSignature(input({ rawBody: reparsed })).ok).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const other = "whsec_" + Buffer.from("a different 32-byte secret value").toString("base64");
    expect(verifyQuoSignature(input({ secret: other }))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a changed webhook-id (it is part of the signed content)", () => {
    expect(verifyQuoSignature(input({ webhookId: "msg_other" }))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a v1 entry with no signature, and non-v1 entries", () => {
    expect(verifyQuoSignature(input({ webhookSignature: "v1," })).ok).toBe(false);
    expect(verifyQuoSignature(input({ webhookSignature: VECTOR.sig.replace("v1,", "v2,") })).ok).toBe(false);
    expect(verifyQuoSignature(input({ webhookSignature: "garbage" })).ok).toBe(false);
  });

  it.each([
    ["webhookId", { webhookId: null }],
    ["webhookTimestamp", { webhookTimestamp: null }],
    ["webhookSignature", { webhookSignature: null }],
    ["empty webhookSignature", { webhookSignature: "" }],
  ])("rejects a missing %s header", (_name, over) => {
    expect(verifyQuoSignature(input(over))).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects an empty or non-base64 secret before computing anything", () => {
    expect(verifyQuoSignature(input({ secret: "" }))).toEqual({ ok: false, reason: "bad_secret" });
    expect(verifyQuoSignature(input({ secret: "whsec_" }))).toEqual({ ok: false, reason: "bad_secret" });
    expect(verifyQuoSignature(input({ secret: "whsec_not base64!" }))).toEqual({ ok: false, reason: "bad_secret" });
  });

  it("rejects a non-numeric timestamp", () => {
    for (const t of ["abc", "1614265330.5", "-1614265330", "1e9", ""]) {
      const r = verifyQuoSignature(input({ webhookTimestamp: t }));
      expect(r.ok, t).toBe(false);
    }
    expect(verifyQuoSignature(input({ webhookTimestamp: "abc" }))).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  describe("timestamp window", () => {
    const secret = VECTOR.secret;
    const body = '{"type":"call.completed"}';
    const at = (signedAt: number, now: number) =>
      verifyQuoSignature({
        rawBody: body,
        webhookId: "msg_window",
        webhookTimestamp: String(signedAt),
        webhookSignature: sign(secret, "msg_window", signedAt, body),
        secret,
        nowSeconds: now,
      });
    const now = 1_800_000_000;

    it("accepts exactly at the old and future limits", () => {
      expect(at(now - MAX_AGE_SECONDS, now)).toEqual({ ok: true });
      expect(at(now + MAX_FUTURE_SKEW_SECONDS, now)).toEqual({ ok: true });
    });

    it("rejects a correctly signed delivery older than 5 minutes (replay)", () => {
      expect(at(now - MAX_AGE_SECONDS - 1, now)).toEqual({ ok: false, reason: "stale_timestamp" });
      expect(at(now - 86_400, now)).toEqual({ ok: false, reason: "stale_timestamp" });
    });

    it("rejects a correctly signed delivery from the future", () => {
      expect(at(now + MAX_FUTURE_SKEW_SECONDS + 1, now)).toEqual({ ok: false, reason: "future_timestamp" });
      expect(at(now + 3_600, now)).toEqual({ ok: false, reason: "future_timestamp" });
    });
  });
});
