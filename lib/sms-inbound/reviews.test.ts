/**
 * Staff review of flagged inbound texts (Plan B.4): the read on the staff
 * session, the resolve RPC and its errors, and the 30-day text purge. No
 * network: the session client is a fake; service_role is never used here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const selects: Array<[string, string]> = [];
const filters: Array<[string, string, unknown]> = [];
let rows: Record<string, unknown[]> = {};
let readError: { code: string; message: string } | null = null;
let rpcAnswer: { data: unknown; error: { code?: string; message?: string; hint?: string } | null } = { data: { status: "resolved" }, error: null };
const rpcCalls: Array<{ name: string; args: unknown }> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "is", "in", "order", "limit"]) {
        b[op] = (col: string, val: unknown) => {
          filters.push([t, `${op}:${col}`, val]);
          return b;
        };
      }
      b.select = (cols: string) => {
        selects.push([t, cols]);
        return b;
      };
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(t === "sms_inbound_events" && readError ? { data: null, error: readError } : { data: rows[t] ?? [], error: null }).then(res);
      return b;
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return rpcAnswer;
    },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    throw new Error("service_role must not be used for staff review");
  },
}));
const assertStaff = vi.fn(async () => ({ userId: "s", role: "staff" }));
vi.mock("@/lib/auth/requireStaff", () => ({ assertStaff: () => assertStaff() }));

import { listOpenSmsReviews, outcomeAllowed, resolveSmsReview, runSmsReviewPurge, SMS_REVIEW_TEXT_RETENTION_DAYS } from "./reviews";

beforeEach(() => {
  selects.length = 0;
  filters.length = 0;
  rpcCalls.length = 0;
  rows = {};
  readError = null;
  rpcAnswer = { data: { status: "resolved" }, error: null };
  assertStaff.mockClear();
});

const EVENT = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  keyword: "STOP",
  review_reason: "keyword_in_message",
  review_text: "please stop texting me",
  received_at: "2026-11-13T15:00:00Z",
  customer_ids: ["c1"],
  phone_key: "6145550143",
  ...over,
});

describe("listOpenSmsReviews", () => {
  it("staff only; open reviews oldest first; names the customers; no phone number for a known customer", async () => {
    rows.sms_inbound_events = [EVENT(), EVENT({ id: "2", review_reason: "cancel_keyword", keyword: "CANCEL", review_text: null, customer_ids: [] })];
    rows.customers = [{ id: "c1", full_name: "Pat Customer" }];
    const list = await listOpenSmsReviews();
    expect(assertStaff).toHaveBeenCalled();
    expect(filters).toEqual(
      expect.arrayContaining([
        ["sms_inbound_events", "eq:needs_review", true],
        ["sms_inbound_events", "is:reviewed_at", null],
        ["sms_inbound_events", "order:received_at", { ascending: true }],
      ]),
    );
    expect(list).toEqual([
      { id: EVENT().id, reason: "keyword_in_message", keyword: "STOP", text: "please stop texting me", receivedAt: "2026-11-13T15:00:00Z", customers: [{ id: "c1", name: "Pat Customer" }], numberHint: null },
      { id: "2", reason: "cancel_keyword", keyword: "CANCEL", text: null, receivedAt: "2026-11-13T15:00:00Z", customers: [], numberHint: "0143" },
    ]);
  });

  it("no customers matched: only the last four digits", async () => {
    rows.sms_inbound_events = [EVENT({ customer_ids: [] })];
    const [r] = (await listOpenSmsReviews())!;
    expect(r.numberHint).toBe("0143");
    expect(JSON.stringify(r)).not.toContain("6145550143");
  });

  it("before the migration (table missing): an empty list", async () => {
    readError = { code: "PGRST205", message: "Could not find the table 'public.sms_inbound_events' in the schema cache" };
    expect(await listOpenSmsReviews()).toEqual([]);
  });

  it("any other read error: null, so the dashboard says it couldn't read them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readError = { code: "42501", message: "permission denied for table sms_inbound_events" };
    expect(await listOpenSmsReviews()).toBeNull();
  });
});

describe("resolveSmsReview", () => {
  it("calls resolve_sms_review on the staff session", async () => {
    await resolveSmsReview("id-1", "not_a_stop");
    expect(assertStaff).toHaveBeenCalled();
    expect(rpcCalls).toEqual([{ name: "resolve_sms_review", args: { p_event_id: "id-1", p_outcome: "not_a_stop" } }]);
  });

  it.each([
    [{ code: "42501", message: "staff only" }, "You do not have permission to do that."],
    [{ code: "22023", message: "already resolved as not_a_stop", hint: "already_resolved" }, "Someone already checked this text — refresh the page."],
    [{ code: "22023", message: "checked is not an outcome for this message" }, "This text can't be resolved that way — refresh the page."],
    [{ code: "XX000", message: "row 6145550143 broke" }, "Something went wrong. Refresh and try again."],
  ])("%j -> %s", async (error, message) => {
    rpcAnswer = { data: null, error };
    await expect(resolveSmsReview("id-1", "checked")).rejects.toThrow(message);
  });

  it("outcomes allowed per reason (the database enforces the same)", () => {
    expect(outcomeAllowed("cancel_keyword", "checked")).toBe(true);
    expect(outcomeAllowed("cancel_keyword", "treated_as_stop")).toBe(false);
    expect(outcomeAllowed("keyword_in_message", "treated_as_stop")).toBe(true);
    expect(outcomeAllowed("keyword_in_message", "not_a_stop")).toBe(true);
    expect(outcomeAllowed("keyword_in_message", "checked")).toBe(false);
  });
});

describe("runSmsReviewPurge (daily, 30 days)", () => {
  it("purges with 30 days", async () => {
    const rpc = vi.fn(async () => ({ data: 3, error: null }));
    expect(await runSmsReviewPurge(rpc)).toEqual({ ok: true, retention_days: 30, purged: 3 });
    expect(rpc).toHaveBeenCalledWith("purge_sms_review_text", { p_days: 30 });
    expect(SMS_REVIEW_TEXT_RETENTION_DAYS).toBe(30);
  });

  it("before the migration: skipped, ok", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.purge_sms_review_text(p_days)" } }));
    expect(await runSmsReviewPurge(rpc)).toEqual({ ok: true, retention_days: 30, purged: 0, skipped: "not_applied" });
  });

  it.each([
    ["a database error", async () => ({ data: null, error: { code: "22023", message: "x" } }), "purge_failed 22023"],
    ["a bad result", async () => ({ data: "3", error: null }), "purge_bad_result"],
    ["a throw", async () => { throw new Error("down"); }, "purge_failed network"],
  ])("%s: ok:false with a code only", async (_l, impl, error) => {
    expect(await runSmsReviewPurge(vi.fn(impl))).toEqual({ ok: false, retention_days: 30, purged: 0, error });
  });
});
