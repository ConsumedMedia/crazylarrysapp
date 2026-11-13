/**
 * Unit test — no network, no database. `fetch` is stubbed (asserted below), so
 * even with CL_NOTIFICATIONS_ENABLED=1 set for this process no Quo/Resend call
 * can leave the machine, and the service client is a fake that captures the
 * notifications_log rows instead of inserting them.
 *
 * Covers what the safe-mode integration test can't: sends are forced off
 * there, so they stop before the CL_NOTIFICATIONS_TEST_TO redirect runs.
 *
 * The customer and TEST_TO fixtures are deliberately NOT reserved contacts
 * (example.com, 555-01xx): the send layer refuses those (reserved-contacts.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const inserted: Record<string, unknown>[] = [];

const BOOKING = {
  id: "00000000-0000-0000-0000-0000000000b1",
  size_requested: "20yd",
  delivery_date: "2026-10-10",
  pickup_date: "2026-10-15",
  delivery_address: "1 Test St, Columbus, OH 43004",
  placement_notes: null,
  total: 401.05,
  payment_status: "paid",
  customers: {
    full_name: "Test Customer",
    email: "customer@crazylarrys.test",
    phone: "614-555-0200",
    sms_consent: true,
  },
};

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    // Plan B.4: every SMS first asks sms_block_status; nothing is blocked here.
    rpc: async (name: string) =>
      name === "sms_block_status" ? { data: null, error: null } : { data: null, error: { code: "unexpected_rpc", message: name } },
    from: (table: string) => {
      if (table === "notifications_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }
      // bookings: .select(...).eq(...).maybeSingle()
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: BOOKING, error: null }),
      };
      return chain;
    },
  }),
}));

const ENV_KEYS = [
  "CL_NOTIFICATIONS_ENABLED",
  "CL_NOTIFICATIONS_TEST_TO",
  "QUO_API_KEY",
  "QUO_FROM_NUMBER",
  "RESEND_API_KEY",
  "RESEND_FROM",
] as const;
const savedEnv: Record<string, string | undefined> = {};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- second param types mock.calls[n][1]
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const body = String(url).includes("quo") ? { data: { id: "quo-msg-1" } } : { id: "resend-msg-1" };
  return new Response(JSON.stringify(body), { status: 202 });
});

beforeEach(() => {
  inserted.length = 0;
  fetchMock.mockClear();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  process.env.QUO_API_KEY = "fake-key";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "fake-key";
  process.env.RESEND_FROM = "Test <test@example.com>";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function run() {
  const { notifyBookingConfirmation } = await import("./notify");
  await notifyBookingConfirmation(BOOKING.id);
  const sms = inserted.find((r) => r.channel === "sms")!;
  const email = inserted.find((r) => r.channel === "email")!;
  return { sms, email };
}

function sentTo(urlPart: string): string[] {
  const call = fetchMock.mock.calls.find(([u]) => String(u).includes(urlPart));
  return call ? JSON.parse(String(call[1]?.body)).to : [];
}

describe("notifications_log records where a send actually went", () => {
  it("phone TEST_TO: SMS logged as redirected (actual + original); email skipped, not redirected", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "6145559999";
    const { sms, email } = await run();

    expect(sentTo("quo")).toEqual(["+16145559999"]);
    expect(sms).toMatchObject({
      delivery_status: "sent",
      recipient: "+16145559999",
      original_recipient: "+16145550200",
      redirected_via: "CL_NOTIFICATIONS_TEST_TO",
      provider_message_id: "quo-msg-1",
    });

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("resend"))).toBe(false);
    expect(email).toMatchObject({
      delivery_status: "skipped",
      failure_category: "test_mode",
      recipient: "customer@crazylarrys.test",
      original_recipient: null,
      redirected_via: null,
    });
  });

  it("email TEST_TO: email logged as redirected; SMS skipped, not redirected", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "tester@crazylarrys.test";
    const { sms, email } = await run();

    expect(sentTo("resend")).toEqual(["tester@crazylarrys.test"]);
    expect(email).toMatchObject({
      delivery_status: "sent",
      recipient: "tester@crazylarrys.test",
      original_recipient: "customer@crazylarrys.test",
      redirected_via: "CL_NOTIFICATIONS_TEST_TO",
      provider_message_id: "resend-msg-1",
    });
    expect(sms).toMatchObject({
      delivery_status: "skipped",
      failure_category: "test_mode",
      recipient: "+16145550200",
      original_recipient: null,
      redirected_via: null,
    });
  });

  it("no TEST_TO: both sent to the customer, original_recipient null", async () => {
    delete process.env.CL_NOTIFICATIONS_TEST_TO;
    const { sms, email } = await run();

    expect(sms).toMatchObject({ delivery_status: "sent", recipient: "+16145550200", original_recipient: null, redirected_via: null });
    expect(email).toMatchObject({ delivery_status: "sent", recipient: "customer@crazylarrys.test", original_recipient: null, redirected_via: null });
  });

  it("a failed redirected send still logs the real destination", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "6145559999";
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ message: "nope" }), { status: 400 }));
    const { sms } = await run();

    expect(sms).toMatchObject({
      delivery_status: "failed",
      failure_category: "provider_rejected",
      recipient: "+16145559999",
      original_recipient: "+16145550200",
      redirected_via: "CL_NOTIFICATIONS_TEST_TO",
    });
  });
});
