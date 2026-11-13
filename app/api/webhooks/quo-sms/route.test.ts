/**
 * The /api/webhooks/quo-sms route: env read at call time, headers passed
 * through, record_sms_inbound called with the right arguments on the service
 * client, and one log line with no number or text. No network: the service
 * client is a fake and fetch is stubbed and asserted unused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const rpc = vi.fn();
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc }) }));

const KEY = Buffer.from("test-only-route-key");
const ENV = { CL_QUO_SMS_WEBHOOK_ENABLED: "1", QUO_SMS_WEBHOOK_KEY: `whsec_${KEY.toString("base64")}`, QUO_ORG_ID: "ORtest" };
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn();

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { status: "recorded", matched: 2, needs_review: false, has_number: true }, error: null });
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function request(text: string, opts: { id?: string } = {}) {
  const body = JSON.stringify({
    id: "EV1",
    type: "message.received",
    createdAt: "2026-11-13T15:00:05.000Z",
    data: {
      resource: { id: "AC_route_1", direction: "incoming", text, createdAt: "2026-11-13T15:00:00.000Z" },
      context: { orgId: "ORtest", phoneNumberId: "PNXYakN6nP", senderIdentifier: "+16145550143", recipientIdentifiers: ["+16145550100"] },
    },
  });
  const id = opts.id ?? "msg_route_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", KEY).update(`${id}.${ts}.${body}`).digest("base64");
  return new NextRequest("https://app.test/api/webhooks/quo-sms", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
  });
}

describe("POST /api/webhooks/quo-sms", () => {
  it("records a STOP through record_sms_inbound with exactly these arguments, logs ids only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("./route");
    const res = await POST(request("STOP"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("record_sms_inbound", {
      p_message_id: "AC_route_1",
      p_webhook_id: "msg_route_1",
      p_sender: "+16145550143",
      p_kind: "opt_out",
      p_keyword: "STOP",
      p_received_at: "2026-11-13T15:00:00.000Z",
      p_review_text: null,
    });
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("quo-sms-webhook"))!;
    expect(line).toContain("quo-sms-webhook recorded");
    expect(line).not.toContain("6145550143");
  });

  it.each([
    ["START", "opt_in", "START", null],
    ["please stop texting me", "review", "STOP", "please stop texting me"],
    ["cancel", "opt_out", "CANCEL", null],
  ])("%j reaches record_sms_inbound as %s / %s with review text %j", async (text, kind, keyword, reviewText) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("./route");
    await POST(request(text));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_kind: kind, p_keyword: keyword, p_review_text: reviewText });
  });

  it("flag off: 503 and the database is never called", async () => {
    process.env.CL_QUO_SMS_WEBHOOK_ENABLED = "0";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("./route");
    expect((await POST(request("STOP"))).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an ordinary text: 200 ignored, the database is never called", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("./route");
    const res = await POST(request("Can you come Friday?"));
    expect(await res.json()).toEqual({ ok: true, ignored: "not_keyword" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the RPC errors: 500 (Quo retries), logged as an error without the message", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "row (+16145550143) violates" } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");
    expect((await POST(request("STOP"))).status).toBe(500);
    expect(String(err.mock.calls[0][0])).toContain("quo-sms-webhook record_failed");
    expect(String(err.mock.calls[0][0])).not.toContain("6145550143");
  });

  it("an RPC answer that isn't recorded/duplicate: 500", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "weird" }, error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./route");
    expect((await POST(request("STOP"))).status).toBe(500);
  });

  it("a duplicate: 200", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "duplicate" }, error: null });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { POST } = await import("./route");
    const res = await POST(request("STOP"));
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });
});
