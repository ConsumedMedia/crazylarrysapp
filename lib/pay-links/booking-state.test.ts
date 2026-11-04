import { describe, it, expect, vi, beforeEach } from "vitest";

const selects: Record<string, string> = {};
const tables: Record<string, unknown[]> = {};
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "in", "order", "limit"]) b[op] = () => b;
      b.select = (cols: string) => {
        selects[t] = cols;
        return b;
      };
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[t] ?? [], error: null }).then(res);
      return b;
    },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    throw new Error("service_role must not be used on the booking page");
  },
}));
vi.mock("@/lib/auth/requireStaff", () => ({ assertStaff: async () => ({ userId: "s", role: "staff" }) }));

import { getPayLinkState, PAY_LINK_STAFF_COLUMNS } from "./booking-state";

beforeEach(() => {
  for (const k of Object.keys(selects)) delete selects[k];
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("getPayLinkState", () => {
  it("names its pay_links columns: no *, no token_hash, no token_encrypted", async () => {
    await getPayLinkState("bk-1");
    expect(selects.pay_links).toBe(PAY_LINK_STAFF_COLUMNS);
    expect(PAY_LINK_STAFF_COLUMNS).not.toMatch(/\*|token_hash|token_encrypted/);
  });

  it("no links: empty state, and nothing else is read", async () => {
    expect(await getPayLinkState("bk-1")).toEqual({
      active: null,
      links: [],
      remindersSent: 0,
      lastReminderAt: null,
      deliveries: [],
    });
    expect(Object.keys(selects)).toEqual(["pay_links"]);
  });

  it("maps the live link, creator, sent reminders, and only the current link's deliveries", async () => {
    tables.pay_links = [
      { id: "pl-2", status: "active", created_by: "u1", created_at: "2026-11-03T15:00:00Z", ended_at: null, ended_reason: null, agreement_ack_at: null, charge_started_at: null, paid_at: null },
      { id: "pl-1", status: "superseded", created_by: "u1", created_at: "2026-11-02T15:00:00Z", ended_at: "2026-11-03T15:00:00Z", ended_reason: null, agreement_ack_at: null, charge_started_at: null, paid_at: null },
    ];
    tables.profiles = [{ id: "u1", full_name: "Office Owner" }];
    tables.pay_link_events = [
      { kind: "customer_reminder", seq: 1, status: "sent", yard_date: "2026-11-04", completed_at: "2026-11-04T12:05:00Z" },
      { kind: "customer_reminder", seq: 2, status: "failed", yard_date: "2026-11-05", completed_at: "2026-11-05T12:05:00Z" },
    ];
    tables.notifications_log = [
      { type: "pay_link_reminder", channel: "email", delivery_status: "sent", failure_category: null, sent_at: "2026-11-04T12:05:00Z", created_at: "2026-11-04T12:05:00Z", original_recipient: "pat@crazylarrys.test" },
      { type: "pay_link", channel: "email", delivery_status: "sent", failure_category: null, sent_at: "2026-11-03T15:00:01Z", created_at: "2026-11-03T15:00:01Z", original_recipient: null },
      { type: "pay_link", channel: "email", delivery_status: "sent", failure_category: null, sent_at: "2026-11-02T15:00:01Z", created_at: "2026-11-02T15:00:01Z", original_recipient: null },
    ];
    const s = await getPayLinkState("bk-1");
    expect(s.active?.id).toBe("pl-2");
    expect(s.active?.createdByName).toBe("Office Owner");
    expect(s.links.map((l) => l.status)).toEqual(["active", "superseded"]);
    expect(s.remindersSent).toBe(1);
    expect(s.lastReminderAt).toBe("2026-11-04T12:05:00Z");
    expect(s.deliveries).toHaveLength(2); // the old link's send is excluded
    expect(s.deliveries[0]).toMatchObject({ type: "pay_link_reminder", redirected: true });
    // The intended recipient is reduced to a flag; the address never leaves.
    expect(JSON.stringify(s)).not.toContain("pat@crazylarrys.test");
  });
});
