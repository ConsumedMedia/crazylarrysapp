/**
 * Unit test — no network, no database. fetch is stubbed; the service client
 * is a fake that captures notifications_log rows. Proves the pay link reaches
 * the provider but never the log, and the channel rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const inserted: Record<string, unknown>[] = [];
let customer: Record<string, unknown>;

const BOOKING = () => ({
  id: "00000000-0000-0000-0000-0000000000b2",
  size_requested: "15yd",
  delivery_date: "2026-11-10",
  pickup_date: "2026-11-15",
  delivery_address: "1 Test St, Columbus, OH 43004",
  placement_notes: null,
  total: 348.3,
  payment_status: "unpaid",
  created_at: "2026-11-02T15:00:00Z",
  customers: customer,
});

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "notifications_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: BOOKING(), error: null }) };
      return chain;
    },
  }),
}));

const ENV = ["CL_NOTIFICATIONS_ENABLED", "CL_NOTIFICATIONS_TEST_TO", "QUO_API_KEY", "QUO_FROM_NUMBER", "RESEND_API_KEY", "RESEND_FROM", "NEXT_PUBLIC_SITE_URL"] as const;
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  void _init;
  return new Response(JSON.stringify(String(url).includes("quo") ? { data: { id: "q1" } } : { id: "r1" }), { status: 202 });
});

beforeEach(() => {
  inserted.length = 0;
  fetchMock.mockClear();
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  delete process.env.CL_NOTIFICATIONS_TEST_TO;
  process.env.QUO_API_KEY = "k";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "k";
  process.env.RESEND_FROM = "T <noreply@crazylarrys.test>";
  delete process.env.NEXT_PUBLIC_SITE_URL;
  customer = { full_name: "Pat <b>Smith</b>", email: "pat@crazylarrys.test", phone: "614-555-0200", sms_consent: true };
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sentBodies = () => fetchMock.mock.calls.map(([, init]) => String(init?.body ?? ""));

describe("notifyPayLink", () => {
  it("sends the working link to the customer by email and SMS", async () => {
    const { notifyPayLink } = await import("./notify");
    await notifyPayLink("b", TOKEN, "pay_link");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const body of sentBodies()) expect(body).toContain(`/pay/${TOKEN}`);
  });

  it("logs both sends with the token redacted", async () => {
    const { notifyPayLink } = await import("./notify");
    await notifyPayLink("b", TOKEN, "pay_link");
    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(row.type).toBe("pay_link");
      expect(row.delivery_status).toBe("sent");
      expect(JSON.stringify(row)).not.toContain(TOKEN);
      expect(String(row.body)).toContain("/pay/…");
    }
  });

  it("escapes the customer's name in the HTML email", async () => {
    const { notifyPayLink } = await import("./notify");
    await notifyPayLink("b", TOKEN, "pay_link");
    const resend = sentBodies().find((b) => b.includes("\"html\""))!;
    const html = JSON.parse(resend).html as string;
    expect(html).toContain("Pat &lt;b&gt;Smith&lt;/b&gt;");
    expect(html).not.toContain("<b>Smith</b>");
  });

  it("no email on file: SMS only, and no 'no email' failure row", async () => {
    customer = { ...customer, email: null };
    const { notifyPayLink } = await import("./notify");
    await notifyPayLink("b", TOKEN, "pay_link");
    expect(inserted.map((r) => r.channel)).toEqual(["sms"]);
  });

  it("no SMS consent: email sent, SMS logged as skipped no_consent", async () => {
    customer = { ...customer, sms_consent: false };
    const { notifyPayLink } = await import("./notify");
    await notifyPayLink("b", TOKEN, "pay_link_reminder");
    const sms = inserted.find((r) => r.channel === "sms")!;
    expect(sms).toMatchObject({ delivery_status: "skipped", failure_category: "no_consent", type: "pay_link_reminder" });
    expect(JSON.stringify(sms)).not.toContain(TOKEN);
  });

  it("TEST_TO (email) redirects the link email to the tester and skips SMS", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "tester@crazylarrys.test";
    const { notifyPayLink } = await import("./notify");
    await notifyPayLink("b", TOKEN, "pay_link");
    const email = inserted.find((r) => r.channel === "email")!;
    expect(email).toMatchObject({ recipient: "tester@crazylarrys.test", original_recipient: "pat@crazylarrys.test", delivery_status: "sent" });
    expect(inserted.find((r) => r.channel === "sms")).toMatchObject({ delivery_status: "skipped", failure_category: "test_mode" });
  });
});

describe("notifyPayLink: the outcome names the variable that redirected it", () => {
  const NEW = ["CL_NOTIFICATIONS_TEST_PHONE", "CL_NOTIFICATIONS_TEST_EMAIL"] as const;
  async function outcomes(env: Partial<Record<(typeof NEW)[number] | "CL_NOTIFICATIONS_TEST_TO", string>>) {
    const before = Object.fromEntries(NEW.map((k) => [k, process.env[k]]));
    for (const k of NEW) delete process.env[k];
    Object.assign(process.env, env);
    try {
      const { notifyPayLink } = await import("./notify");
      return await notifyPayLink("b", TOKEN, "pay_link");
    } finally {
      for (const k of NEW) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  }
  it("the new variables: each channel names its own", async () => {
    const out = await outcomes({ CL_NOTIFICATIONS_TEST_PHONE: "6145559999", CL_NOTIFICATIONS_TEST_EMAIL: "tester@crazylarrys.test" });
    expect(out.find((o) => o.channel === "sms")).toMatchObject({ status: "sent", redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_PHONE" });
    expect(out.find((o) => o.channel === "email")).toMatchObject({ status: "sent", redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_EMAIL" });
  });
  it("only the old variable: names CL_NOTIFICATIONS_TEST_TO", async () => {
    const out = await outcomes({ CL_NOTIFICATIONS_TEST_TO: "tester@crazylarrys.test" });
    expect(out.find((o) => o.channel === "email")).toMatchObject({ redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_TO" });
  });
  it("not redirected: no variable on the outcome", async () => {
    const out = await outcomes({});
    for (const o of out) {
      expect(o.redirected).toBe(false);
      expect(o).not.toHaveProperty("redirectedVia");
    }
  });
});

describe("notifyStaffUnpaidAlert", () => {
  it("emails each recipient only, with the staff booking URL, days unpaid, escaped name", async () => {
    const { notifyStaffUnpaidAlert } = await import("./notify");
    await notifyStaffUnpaidAlert({
      bookingId: "bk-1",
      recipients: [{ email: "owner1@crazylarrys.test" }, { email: "owner2@crazylarrys.test" }],
      reason: "after_days",
      remindersSent: 1,
      today: "2026-11-05",
    });
    expect(inserted.map((r) => [r.channel, r.recipient, r.type])).toEqual([
      ["email", "owner1@crazylarrys.test", "staff_unpaid_alert"],
      ["email", "owner2@crazylarrys.test", "staff_unpaid_alert"],
    ]);
    const body = JSON.parse(sentBodies()[0]);
    expect(body.subject).toContain("(3 days)");
    expect(body.text).toContain("https://app.crazylarrysdumpsters.com/bookings/bk-1");
    expect(body.html).not.toContain("<b>Smith</b>");
  });
});
