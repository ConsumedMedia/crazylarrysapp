import { describe, it, expect, vi, beforeEach } from "vitest";

const selects: Record<string, string> = {};
const tables: Record<string, unknown[]> = {};
/** Every select, in order, as [table, columns]. */
const selectHistory: Array<[string, string]> = [];
/** Optional: an error for a select, decided by its table and columns. */
let failSelect: (t: string, cols: string) => { code: string; message: string } | null = () => null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      let cols = "";
      for (const op of ["eq", "in", "order", "limit"]) b[op] = () => b;
      b.select = (c: string) => {
        selects[t] = c;
        cols = c;
        selectHistory.push([t, c]);
        return b;
      };
      b.then = (res: (v: unknown) => unknown) => {
        const error = failSelect(t, cols);
        return Promise.resolve(error ? { data: null, error } : { data: tables[t] ?? [], error: null }).then(res);
      };
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
  selectHistory.length = 0;
  failSelect = () => null;
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

describe("getPayLinkState: which test variable redirected a delivery (redirected_via, migration 20261112000000)", () => {
  const LINK = { id: "pl-2", status: "active", created_by: null, created_at: "2026-11-03T15:00:00Z", ended_at: null, ended_reason: null, agreement_ack_at: null, charge_started_at: null, paid_at: null };
  const logRow = (over: Record<string, unknown>) => ({
    type: "pay_link",
    channel: "email",
    delivery_status: "sent",
    failure_category: null,
    sent_at: "2026-11-03T15:00:01Z",
    created_at: "2026-11-03T15:00:01Z",
    original_recipient: null,
    redirected_via: null,
    ...over,
  });
  const logSelects = () => selectHistory.filter(([t]) => t === "notifications_log").map(([, c]) => c);

  beforeEach(() => {
    tables.pay_links = [LINK];
  });

  it("reads redirected_via along with the other delivery columns, and nothing else new", async () => {
    tables.notifications_log = [];
    await getPayLinkState("bk-1");
    expect(logSelects()).toEqual(["type, channel, delivery_status, failure_category, sent_at, created_at, original_recipient, redirected_via"]);
  });

  it("names the variable on a redirected delivery that recorded it", async () => {
    tables.notifications_log = [
      logRow({ channel: "sms", original_recipient: "+16145550200", redirected_via: "CL_NOTIFICATIONS_TEST_PHONE" }),
      logRow({ original_recipient: "pat@crazylarrys.test", redirected_via: "CL_NOTIFICATIONS_TEST_EMAIL" }),
    ];
    const s = await getPayLinkState("bk-1");
    expect(s.deliveries).toEqual([
      expect.objectContaining({ channel: "sms", redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_PHONE" }),
      expect.objectContaining({ channel: "email", redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_EMAIL" }),
    ]);
    expect(JSON.stringify(s)).not.toContain("pat@crazylarrys.test");
    expect(JSON.stringify(s)).not.toContain("6145550200");
  });

  it("a redirected row from before the migration (null) has no redirectedVia, so the page says only 'the test address'", async () => {
    tables.notifications_log = [logRow({ original_recipient: "pat@crazylarrys.test", redirected_via: null })];
    const [d] = (await getPayLinkState("bk-1")).deliveries;
    expect(d.redirected).toBe(true);
    expect(d).not.toHaveProperty("redirectedVia");
  });

  it("a name on a row that wasn't redirected is ignored", async () => {
    tables.notifications_log = [logRow({ original_recipient: null, redirected_via: "CL_NOTIFICATIONS_TEST_TO" })];
    const [d] = (await getPayLinkState("bk-1")).deliveries;
    expect(d.redirected).toBe(false);
    expect(d).not.toHaveProperty("redirectedVia");
  });

  it("column not there yet (42703): reads again without it, and the page still renders", async () => {
    failSelect = (t, cols) =>
      t === "notifications_log" && cols.includes("redirected_via")
        ? { code: "42703", message: "column notifications_log.redirected_via does not exist" }
        : null;
    tables.notifications_log = [logRow({ original_recipient: "pat@crazylarrys.test", redirected_via: undefined })];
    const s = await getPayLinkState("bk-1");
    expect(logSelects()).toEqual([
      "type, channel, delivery_status, failure_category, sent_at, created_at, original_recipient, redirected_via",
      "type, channel, delivery_status, failure_category, sent_at, created_at, original_recipient",
    ]);
    expect(s.deliveries).toEqual([expect.objectContaining({ redirected: true })]);
    expect(s.deliveries[0]).not.toHaveProperty("redirectedVia");
  });

  it("any other read error still throws (no silent fallback)", async () => {
    failSelect = (t) => (t === "notifications_log" ? { code: "42501", message: "permission denied for table notifications_log" } : null);
    await expect(getPayLinkState("bk-1")).rejects.toThrow("notifications_log: permission denied");
    expect(logSelects()).toHaveLength(1);
  });

  it("an error naming another missing column still throws", async () => {
    failSelect = (t) => (t === "notifications_log" ? { code: "42703", message: "column notifications_log.sent_at does not exist" } : null);
    await expect(getPayLinkState("bk-1")).rejects.toThrow("notifications_log: column notifications_log.sent_at");
  });
});
