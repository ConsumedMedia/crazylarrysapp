/**
 * Decrypt-and-send, end to end through the REAL notify code — no network, no
 * database. The service client is a fake that answers the cron's RPCs and
 * captures every notifications_log row; fetch is stubbed and records what the
 * providers would have received.
 *
 * Proves: the reminder the customer gets carries the working link (the
 * decrypted token), and the same log-scan rule the DB test runs against
 * notifications_log finds no live token in anything that was logged.
 * scripts/probe-pay-link-token.mjs proves the database side: the stored copy
 * decrypts to exactly the issued token, and the scan catches a raw one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const LIVE_TOKENS = new Set([TOKEN]);
const logRows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string) => {
      switch (name) {
        case "purge_pay_link_lookup_attempts": return { data: 0, error: null };
        case "pay_link_due_events": return { data: [{ booking_id: "b1", kind: "customer_reminder", seq: 1 }], error: null };
        case "pay_link_reminder_token": return { data: { state: "ok", token: TOKEN }, error: null };
        case "claim_pay_link_event": return { data: true, error: null };
        default: return { data: null, error: null };
      }
    },
    from: (table: string) => {
      if (table === "notifications_log") {
        return { insert: async (row: Record<string, unknown>) => (logRows.push(row), { error: null }) };
      }
      const data =
        table === "cl_pay_link_settings"
          ? { enabled: true, staff_alert_each_reminder: false }
          : {
              id: "b1", size_requested: "15yd", delivery_date: "2026-11-10", pickup_date: "2026-11-15",
              delivery_address: "1 Test St, Columbus, OH 43004", placement_notes: null, total: 348.3,
              payment_status: "unpaid",
              customers: { full_name: "Pat Smith", email: "pat@crazylarrys.test", phone: "614-555-0200", sms_consent: true },
            };
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }) };
      return chain;
    },
  }),
}));
vi.mock("@/lib/quickbooks/tokens", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/quickbooks/invoice-payments", () => ({ reconcileInvoicePayments: vi.fn() }));
vi.mock("@/lib/quickbooks/config", () => ({ quickBooksConfigured: () => false, missingQuickBooksEnv: () => [] }));

const ENV = ["CL_NOTIFICATIONS_ENABLED", "CL_NOTIFICATIONS_TEST_TO", "QUO_API_KEY", "QUO_FROM_NUMBER", "RESEND_API_KEY", "RESEND_FROM", "CL_PAY_LINK_TOKEN_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  void _init;
  return new Response(JSON.stringify(String(url).includes("quo") ? { data: { id: "q1" } } : { id: "r1" }), { status: 202 });
});

/** The rule pay-links.integration.test.ts applies to the real table. */
function liveTokensIn(rows: Record<string, unknown>[]): string[] {
  const found: string[] = [];
  for (const r of rows) {
    const text = `${r.body ?? ""} ${r.error ?? ""}`;
    for (const m of Array.from(text.matchAll(/\/pay\/([A-Za-z0-9_-]{43})/g))) if (LIVE_TOKENS.has(m[1])) found.push(m[1]);
  }
  return found;
}

beforeEach(() => {
  logRows.length = 0;
  fetchMock.mockClear();
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  delete process.env.CL_NOTIFICATIONS_TEST_TO;
  process.env.QUO_API_KEY = "k";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "k";
  process.env.RESEND_FROM = "T <noreply@crazylarrys.test>";
  process.env.CL_PAY_LINK_TOKEN_KEY = "x".repeat(40);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("reminder: decrypt, send, then scan the log", () => {
  it("the customer gets the working link by email and SMS", async () => {
    const { runPayLinks } = await import("./jobs");
    const r = await runPayLinks();
    expect(r.customer_reminders.sent).toBe(1);
    const bodies = fetchMock.mock.calls.map(([, init]) => String(init?.body ?? ""));
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(b).toContain(`/pay/${TOKEN}`);
  });

  it("nothing logged holds a live token (log-scan check)", async () => {
    const { runPayLinks } = await import("./jobs");
    await runPayLinks();
    expect(logRows.map((r) => r.type)).toEqual(["pay_link_reminder", "pay_link_reminder"]);
    expect(liveTokensIn(logRows)).toEqual([]);
    expect(JSON.stringify(logRows)).not.toContain(TOKEN);
  });

  it("the scan rule itself catches an unredacted row (positive control)", () => {
    expect(liveTokensIn([{ body: `Pay here: https://x/pay/${TOKEN}` }])).toEqual([TOKEN]);
  });
});
