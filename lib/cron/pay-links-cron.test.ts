/**
 * Unit test for runPayLinks — no network, no database. The service client is
 * a fake; the notify functions are spies. Clock pinned across the Nov 1
 * change: 11:30 PM EST Sun Nov 1 is Nov 2 in UTC, and the cron must ask the
 * database for the YARD day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "k".repeat(40);
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
let rpcs: Record<string, Rpc>;
let settings: { enabled: boolean; staff_alert_each_reminder: boolean };
const calls: Array<[string, Record<string, unknown>]> = [];

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push([name, args]);
      return rpcs[name] ? rpcs[name](args) : { data: null, error: null };
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === "cl_pay_link_settings" ? settings : null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ count: 1, error: null }),
      };
      return chain;
    },
  }),
}));
const notifyStaffUnpaidAlert = vi.fn(async (o: unknown) => void o);
const notifyPayLink = vi.fn(async (id: string, token: string, type: string) => void [id, token, type]);
vi.mock("@/lib/notifications/notify", () => ({
  notifyOverdue: vi.fn(),
  notifyDeliveryReminder: vi.fn(),
  notifyPickupReminder: vi.fn(),
  alreadyNotified: vi.fn(),
  notifyStaffUnpaidAlert: (o: unknown) => notifyStaffUnpaidAlert(o),
  notifyPayLink: (id: string, token: string, type: string) => notifyPayLink(id, token, type),
}));
vi.mock("@/lib/quickbooks/tokens", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/quickbooks/invoice-payments", () => ({ reconcileInvoicePayments: vi.fn() }));
vi.mock("@/lib/quickbooks/config", () => ({ quickBooksConfigured: () => false, missingQuickBooksEnv: () => [] }));

const called = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);
let savedKey: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T04:30:00Z")); // 11:30 PM EST Sun Nov 1
  calls.length = 0;
  notifyStaffUnpaidAlert.mockClear();
  notifyPayLink.mockClear();
  savedKey = process.env.CL_PAY_LINK_TOKEN_KEY;
  process.env.CL_PAY_LINK_TOKEN_KEY = KEY;
  settings = { enabled: true, staff_alert_each_reminder: false };
  rpcs = {
    purge_pay_link_lookup_attempts: () => ({ data: 4, error: null }),
    pay_link_due_events: () => ({
      data: [
        { booking_id: "b1", kind: "staff_alert", seq: 1 },
        { booking_id: "b2", kind: "customer_reminder", seq: 2 },
        { booking_id: "b3", kind: "staff_alert", seq: 1 },
      ],
      error: null,
    }),
    claim_pay_link_event: (a) => ({ data: a.p_booking_id !== "b3", error: null }), // b3 already claimed
    pay_link_staff_alert_recipients: () => ({ data: [{ email: "owner@crazylarrys.test", via_fallback: true }], error: null }),
    pay_link_reminder_token: () => ({ data: { state: "ok", token: TOKEN }, error: null }),
  };
});
afterEach(() => {
  vi.useRealTimers();
  if (savedKey === undefined) delete process.env.CL_PAY_LINK_TOKEN_KEY;
  else process.env.CL_PAY_LINK_TOKEN_KEY = savedKey;
});

const run = async () => (await import("./jobs")).runPayLinks();

describe("runPayLinks", () => {
  it("feature OFF: purges rate-limit rows and does nothing else", async () => {
    settings.enabled = false;
    const r = await run();
    expect(r).toMatchObject({ ok: true, enabled: false, purged_lookup_rows: 4, staff_alerts: { sent: 0 }, customer_reminders: { sent: 0 } });
    expect(called("pay_link_due_events")).toHaveLength(0);
    expect(called("pay_link_reminder_token")).toHaveLength(0);
    expect(called("claim_pay_link_event")).toHaveLength(0);
  });

  it("asks for the YARD day (Nov 1), not UTC's Nov 2", async () => {
    const r = await run();
    expect(r.date).toBe("2026-11-01");
    expect(called("pay_link_due_events")[0]).toEqual({ p_today: "2026-11-01" });
  });

  it("staff alerts: claims BEFORE sending; an already-claimed alert sends nothing", async () => {
    const r = await run();
    expect(r.staff_alerts).toEqual({ sent: 1, already_claimed: 1, no_recipients: 0 });
    expect(notifyStaffUnpaidAlert).toHaveBeenCalledTimes(1);
    expect(notifyStaffUnpaidAlert.mock.calls[0][0]).toMatchObject({ bookingId: "b1", reason: "after_days", today: "2026-11-01" });
    const order = calls.map(([n, a]) => `${n}:${a.p_booking_id ?? ""}:${a.p_kind ?? ""}`);
    expect(order.indexOf("claim_pay_link_event:b1:staff_alert")).toBeLessThan(order.indexOf("finish_pay_link_event:b1:staff_alert"));
  });

  it("customer reminder: decrypts the live link with the key, THEN claims, sends it, finishes", async () => {
    const r = await run();
    expect(r.customer_reminders).toMatchObject({ sent: 1, already_claimed: 0 });
    expect(called("pay_link_reminder_token")[0]).toEqual({ p_booking_id: "b2", p_key: KEY });
    expect(notifyPayLink).toHaveBeenCalledWith("b2", TOKEN, "pay_link_reminder");
    const order = calls.map(([n, a]) => `${n}:${a.p_booking_id ?? ""}:${a.p_kind ?? ""}`);
    const tokenAt = order.indexOf("pay_link_reminder_token:b2:");
    const claimAt = order.indexOf("claim_pay_link_event:b2:customer_reminder");
    expect(tokenAt).toBeLessThan(claimAt);
    expect(claimAt).toBeLessThan(order.indexOf("finish_pay_link_event:b2:customer_reminder"));
    expect(called("claim_pay_link_event").find((a) => a.p_kind === "customer_reminder")).toMatchObject({ p_seq: 2 });
    expect(r.ok).toBe(true);
  });

  it("an already-claimed reminder (a re-run) is not sent again", async () => {
    rpcs.claim_pay_link_event = () => ({ data: false, error: null });
    const r = await run();
    expect(r.customer_reminders).toMatchObject({ sent: 0, already_claimed: 1 });
    expect(notifyPayLink).not.toHaveBeenCalled();
  });

  it("key missing: nothing decrypted or claimed, reminder counted, job reports ok:false", async () => {
    delete process.env.CL_PAY_LINK_TOKEN_KEY;
    const r = await run();
    expect(r.customer_reminders.not_sent.no_key).toBe(1);
    expect(called("pay_link_reminder_token")).toHaveLength(0);
    expect(called("claim_pay_link_event").some((a) => a.p_kind === "customer_reminder")).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("CL_PAY_LINK_TOKEN_KEY is not set");
    expect(r.staff_alerts.sent).toBe(1); // staff alerts don't need the key
  });

  it("a key under 32 characters counts as missing", async () => {
    process.env.CL_PAY_LINK_TOKEN_KEY = "short";
    const r = await run();
    expect(r.customer_reminders.not_sent.no_key).toBe(1);
  });

  it.each([
    ["no_stored_token", "Resend"],
    ["decrypt_failed", "didn't decrypt"],
  ])("link state %s: not claimed, counted, reported", async (state, words) => {
    rpcs.pay_link_reminder_token = () => ({ data: { state }, error: null });
    const r = await run();
    expect(r.customer_reminders.not_sent[state as "no_stored_token"]).toBe(1);
    expect(called("claim_pay_link_event").some((a) => a.p_kind === "customer_reminder")).toBe(false);
    expect(notifyPayLink).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain(words);
  });

  it("per-reminder staff alert when the Settings box is ticked, with the reminder count", async () => {
    settings.staff_alert_each_reminder = true;
    await run();
    const onReminder = called("claim_pay_link_event").find((a) => a.p_kind === "staff_alert_on_reminder");
    expect(onReminder).toMatchObject({ p_booking_id: "b2", p_seq: 2 });
    expect(notifyStaffUnpaidAlert.mock.calls.map(([o]) => o)).toContainEqual(
      expect.objectContaining({ bookingId: "b2", reason: "reminder_sent", remindersSent: 2 }),
    );
  });

  it("no recipients at all: marks the claimed alert failed, sends nothing", async () => {
    rpcs.pay_link_staff_alert_recipients = () => ({ data: [], error: null });
    const r = await run();
    expect(r.staff_alerts.no_recipients).toBe(1);
    expect(notifyStaffUnpaidAlert).not.toHaveBeenCalled();
    expect(called("finish_pay_link_event").find((a) => a.p_kind === "staff_alert")).toMatchObject({ p_status: "failed" });
  });
});
