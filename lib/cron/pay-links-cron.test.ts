/**
 * Unit test for runPayLinks — no network, no database. The service client is
 * a fake; notifyStaffUnpaidAlert is a spy. Clock pinned across the Nov 1
 * change: 11:30 PM EST Sun Nov 1 is Nov 2 in UTC, and the cron must ask the
 * database for the YARD day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
let rpcs: Record<string, Rpc>;
let enabled: boolean;
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
        maybeSingle: async () => ({ data: table === "cl_pay_link_settings" ? { enabled } : null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ count: 1, error: null }),
      };
      return chain;
    },
  }),
}));
const notifyStaffUnpaidAlert = vi.fn(async (o: unknown) => void o);
vi.mock("@/lib/notifications/notify", () => ({
  notifyOverdue: vi.fn(),
  notifyDeliveryReminder: vi.fn(),
  notifyPickupReminder: vi.fn(),
  alreadyNotified: vi.fn(),
  notifyStaffUnpaidAlert: (o: unknown) => notifyStaffUnpaidAlert(o),
}));
vi.mock("@/lib/quickbooks/tokens", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/quickbooks/invoice-payments", () => ({ reconcileInvoicePayments: vi.fn() }));
vi.mock("@/lib/quickbooks/config", () => ({ quickBooksConfigured: () => false, missingQuickBooksEnv: () => [] }));

const called = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T04:30:00Z")); // 11:30 PM EST Sun Nov 1
  calls.length = 0;
  notifyStaffUnpaidAlert.mockClear();
  enabled = true;
  rpcs = {
    purge_pay_link_lookup_attempts: () => ({ data: 4, error: null }),
    pay_link_due_events: () => ({
      data: [
        { booking_id: "b1", kind: "staff_alert", seq: 1 },
        { booking_id: "b2", kind: "customer_reminder", seq: 1 },
        { booking_id: "b3", kind: "staff_alert", seq: 1 },
      ],
      error: null,
    }),
    claim_pay_link_event: (a) => ({ data: a.p_booking_id !== "b3", error: null }), // b3 already claimed
    pay_link_staff_alert_recipients: () => ({ data: [{ email: "owner@crazylarrys.test", via_fallback: true }], error: null }),
  };
});
afterEach(() => vi.useRealTimers());

describe("runPayLinks", () => {
  it("feature OFF: purges rate-limit rows and does nothing else", async () => {
    enabled = false;
    const { runPayLinks } = await import("./jobs");
    const r = await runPayLinks();
    expect(r).toMatchObject({ enabled: false, purged_lookup_rows: 4, staff_alerts: { sent: 0 } });
    expect(called("pay_link_due_events")).toHaveLength(0);
    expect(called("claim_pay_link_event")).toHaveLength(0);
    expect(notifyStaffUnpaidAlert).not.toHaveBeenCalled();
  });

  it("asks for the YARD day (Nov 1), not UTC's Nov 2", async () => {
    const { runPayLinks } = await import("./jobs");
    const r = await runPayLinks();
    expect(r.date).toBe("2026-11-01");
    expect(called("pay_link_due_events")[0]).toEqual({ p_today: "2026-11-01" });
  });

  it("claims BEFORE sending; an already-claimed alert sends nothing", async () => {
    const { runPayLinks } = await import("./jobs");
    const r = await runPayLinks();
    expect(r.staff_alerts).toEqual({ sent: 1, already_claimed: 1, no_recipients: 0 });
    expect(notifyStaffUnpaidAlert).toHaveBeenCalledTimes(1);
    expect(notifyStaffUnpaidAlert.mock.calls[0][0]).toMatchObject({ bookingId: "b1", reason: "after_days", today: "2026-11-01", recipients: [{ email: "owner@crazylarrys.test" }] });
    const order = calls.map(([n, a]) => `${n}:${a.p_booking_id ?? ""}`);
    expect(order.indexOf("claim_pay_link_event:b1")).toBeLessThan(order.indexOf("finish_pay_link_event:b1"));
    expect(called("finish_pay_link_event")[0]).toMatchObject({ p_booking_id: "b1", p_status: "sent" });
  });

  it("customer reminders are counted as waiting and never claimed (link can't be rebuilt yet)", async () => {
    const { runPayLinks } = await import("./jobs");
    const r = await runPayLinks();
    expect(r.customer_reminders_waiting).toBe(1);
    expect(called("claim_pay_link_event").some((a) => a.p_kind === "customer_reminder")).toBe(false);
  });

  it("no recipients at all: marks the claimed alert failed, sends nothing", async () => {
    rpcs.pay_link_staff_alert_recipients = () => ({ data: [], error: null });
    const { runPayLinks } = await import("./jobs");
    const r = await runPayLinks();
    expect(r.staff_alerts.no_recipients).toBe(1);
    expect(notifyStaffUnpaidAlert).not.toHaveBeenCalled();
    expect(called("finish_pay_link_event")[0]).toMatchObject({ p_status: "failed" });
  });
});
