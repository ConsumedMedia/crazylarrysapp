/**
 * Every SMS checks the opt-out list first (Plan B.4). Unit test: fetch is
 * stubbed (no Quo/Resend call can leave the machine) and the service client is
 * a fake whose sms_block_status answer each test sets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const inserted: Record<string, unknown>[] = [];
const rpcCalls: Array<{ name: string; args: unknown }> = [];
type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null } | Error;
let blockAnswer: RpcAnswer = { data: null, error: null };

const BOOKING = {
  id: "00000000-0000-0000-0000-0000000000b4",
  size_requested: "20yd",
  delivery_date: "2026-11-20",
  pickup_date: "2026-11-27",
  delivery_address: "1 Test St, Columbus, OH 43004",
  placement_notes: null,
  total: 401.05,
  payment_status: "paid",
  customers: { full_name: "Test Customer", email: "customer@crazylarrys.test", phone: "614-321-7654", sms_consent: true },
};
const JOB = { id: "job-1", type: "delivery", scheduled_date: "2026-11-20", booking_id: BOOKING.id };
const DRIVER = { full_name: "Test Driver", phone: "614-321-9876" };

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name !== "sms_block_status") return { data: null, error: { code: "unexpected_rpc", message: name } };
      if (blockAnswer instanceof Error) throw blockAnswer;
      return blockAnswer;
    },
    from: (table: string) => {
      if (table === "notifications_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }
      const data = table === "jobs" ? JOB : table === "drivers" ? DRIVER : BOOKING;
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }) };
      return chain;
    },
  }),
}));

const ENV_KEYS = [
  "CL_NOTIFICATIONS_ENABLED",
  "CL_NOTIFICATIONS_TEST_PHONE",
  "CL_NOTIFICATIONS_TEST_EMAIL",
  "CL_NOTIFICATIONS_TEST_TO",
  "QUO_API_KEY",
  "QUO_FROM_NUMBER",
  "RESEND_API_KEY",
  "RESEND_FROM",
] as const;
const saved: Record<string, string | undefined> = {};
let quoStatus = 202;
let quoBody: unknown = { data: { id: "q1" } };
const fetchMock = vi.fn(async (url: string) =>
  String(url).includes("quo")
    ? new Response(JSON.stringify(quoBody), { status: quoStatus })
    : new Response(JSON.stringify({ id: "r1" }), { status: 202 }),
);
const quoCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("quo")).length;
const resendCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("resend")).length;

beforeEach(() => {
  inserted.length = 0;
  rpcCalls.length = 0;
  blockAnswer = { data: null, error: null };
  quoStatus = 202;
  quoBody = { data: { id: "q1" } };
  fetchMock.mockClear();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  process.env.QUO_API_KEY = "fake-key";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "fake-key";
  process.env.RESEND_FROM = "Test <test@crazylarrys.test>";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function confirm() {
  const { notifyBookingConfirmation } = await import("./notify");
  await notifyBookingConfirmation(BOOKING.id);
  return { sms: inserted.find((r) => r.channel === "sms"), email: inserted.find((r) => r.channel === "email") };
}

describe("customer texts check the opt-out list first", () => {
  it("not blocked: sent as before; the check is on the customer's number in E.164", async () => {
    const { sms } = await confirm();
    expect(sms).toMatchObject({ delivery_status: "sent" });
    expect(rpcCalls).toEqual([{ name: "sms_block_status", args: { p_phone: "+16143217654" } }]);
    expect(quoCalls()).toBe(1);
  });

  it("opted out: the text is not sent, logged as skipped opted_out; the email still goes", async () => {
    blockAnswer = { data: "opted_out", error: null };
    const { sms, email } = await confirm();
    expect(quoCalls()).toBe(0);
    expect(sms).toMatchObject({ delivery_status: "skipped", failure_category: "opted_out", error: "the number replied STOP" });
    expect(email).toMatchObject({ delivery_status: "sent" });
    expect(resendCalls()).toBe(1);
  });

  it("a flagged reply waiting for staff: blocked the same way", async () => {
    blockAnswer = { data: "pending_review", error: null };
    const { sms } = await confirm();
    expect(quoCalls()).toBe(0);
    expect(sms).toMatchObject({ delivery_status: "skipped", failure_category: "opted_out", error: "a reply that may be an opt-out is waiting for staff review" });
  });

  it("no consent: skipped as before, and the list isn't even asked", async () => {
    const { notifyBookingConfirmation } = await import("./notify");
    const prev = BOOKING.customers.sms_consent;
    BOOKING.customers.sms_consent = false;
    try {
      await notifyBookingConfirmation(BOOKING.id);
    } finally {
      BOOKING.customers.sms_consent = prev;
    }
    expect(inserted.find((r) => r.channel === "sms")).toMatchObject({ failure_category: "no_consent" });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("the list can't be read: nothing is sent", () => {
  it.each([
    ["a database error", { data: null, error: { code: "XX000", message: "boom" } }, "sms_block_status XX000"],
    ["a thrown error", new Error("network down"), "sms_block_status network"],
    ["an answer that isn't a status", { data: "maybe", error: null }, "sms_block_status bad_result"],
    ["a different missing function", { data: null, error: { code: "PGRST202", message: "Could not find the function public.something_else" } }, "sms_block_status PGRST202"],
  ] as const)("%s: failed transient, not sent", async (_l, answer, err) => {
    blockAnswer = answer as RpcAnswer;
    const { sms } = await confirm();
    expect(quoCalls()).toBe(0);
    expect(sms).toMatchObject({ delivery_status: "failed", failure_category: "transient", error: `opt-out list unreadable, not sent (${err})` });
  });

  it("before the migration (sms_block_status doesn't exist yet): texts as before, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    blockAnswer = { data: null, error: { code: "PGRST202", message: "Could not find the function public.sms_block_status(p_phone) in the schema cache" } };
    const { sms } = await confirm();
    expect(sms).toMatchObject({ delivery_status: "sent" });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("drivers are checked too", () => {
  it("a driver's number that replied STOP gets no job text", async () => {
    blockAnswer = { data: "opted_out", error: null };
    const { notifyJobAssigned } = await import("./notify");
    await notifyJobAssigned("job-1", "drv-1");
    expect(rpcCalls).toEqual([{ name: "sms_block_status", args: { p_phone: "+16143219876" } }]);
    expect(quoCalls()).toBe(0);
    expect(inserted).toEqual([expect.objectContaining({ type: "job_assigned", channel: "sms", failure_category: "opted_out" })]);
  });

  it("not blocked: the driver's text goes", async () => {
    const { notifyJobAssigned } = await import("./notify");
    await notifyJobAssigned("job-1", "drv-1");
    expect(quoCalls()).toBe(1);
  });
});

describe("test mode", () => {
  it("the check is on the customer's number, not the test phone, so test mode behaves as production will", async () => {
    process.env.CL_NOTIFICATIONS_TEST_PHONE = "6145559999";
    blockAnswer = { data: "opted_out", error: null };
    const { sms } = await confirm();
    expect(rpcCalls[0].args).toEqual({ p_phone: "+16143217654" });
    expect(quoCalls()).toBe(0);
    expect(sms).toMatchObject({ failure_category: "opted_out", original_recipient: null });
  });
});

describe("Quo's own opted-out refusal", () => {
  it.each(["User Opted Out", "User has opted out of receiving messages", "recipient opted-out"])("400 %j -> opted_out", async (message) => {
    quoStatus = 400;
    quoBody = { message };
    const { sendSms } = await import("./sms");
    const r = await sendSms("+16143217654", "hi");
    expect(r).toMatchObject({ ok: false, category: "opted_out" });
  });

  it("other 400s keep their category", async () => {
    quoStatus = 400;
    quoBody = { message: "A2P registration incomplete" };
    const { sendSms } = await import("./sms");
    expect((await sendSms("+16143217654", "hi")).category).toBe("account_blocked");
  });
});

describe("the staff label", () => {
  it("names the STOP reply", async () => {
    const { outcomeLine } = await import("@/app/(admin)/bookings/_components/PayLinkResult");
    expect(outcomeLine({ channel: "sms", status: "skipped", category: "opted_out", redirected: false })).toBe(
      "Text not sent: the number replied STOP (or a reply is waiting for staff to check)",
    );
  });
});
