/**
 * Unit test — no network, no database. `fetch` is stubbed, so even with
 * CL_NOTIFICATIONS_ENABLED=1 for this process no Quo/Resend call leaves the
 * machine; the service client is a fake that captures notifications_log rows.
 *
 * The big table runs the REAL sendSms / sendEmail over every combination of
 * CL_NOTIFICATIONS_TEST_PHONE, CL_NOTIFICATIONS_TEST_EMAIL and
 * CL_NOTIFICATIONS_TEST_TO (unset, blank, usable, wrong shape, reserved, the
 * other channel's shape) with a real-looking customer, and proves:
 *   - test mode on (any of the three set): nothing reaches the customer;
 *     each channel goes only to its own test target (new variable first,
 *     then CL_NOTIFICATIONS_TEST_TO if it has that channel's shape);
 *   - no usable target: not sent, and the reason names the variable to set;
 *   - all three unset: both channels go to the customer.
 * Expected targets come from the fixture data (what each value yields), not
 * from test-mode.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { envWarnings } from "@/lib/pay-links/settings-shared";
import { testModeOn } from "./test-mode";

const inserted: Record<string, unknown>[] = [];

const CUSTOMER_PHONE = "+16143217654";
const CUSTOMER_EMAIL = "pat.customer@gmail.com";

const BOOKING = {
  id: "00000000-0000-0000-0000-0000000000c1",
  size_requested: "20yd",
  delivery_date: "2026-12-10",
  pickup_date: "2026-12-15",
  delivery_address: "1 Test St, Columbus, OH 43004",
  placement_notes: null,
  total: 401.05,
  payment_status: "paid",
  customers: { full_name: "Pat Customer", email: CUSTOMER_EMAIL, phone: "614-321-7654", sms_consent: true },
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
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: BOOKING, error: null }) };
      return chain;
    },
  }),
}));

const TEST_VARS = ["CL_NOTIFICATIONS_TEST_PHONE", "CL_NOTIFICATIONS_TEST_EMAIL", "CL_NOTIFICATIONS_TEST_TO"] as const;
const ENV_KEYS = [...TEST_VARS, "CL_NOTIFICATIONS_ENABLED", "QUO_API_KEY", "QUO_FROM_NUMBER", "RESEND_API_KEY", "RESEND_FROM"] as const;
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
  for (const k of TEST_VARS) delete process.env[k];
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  process.env.QUO_API_KEY = "fake-key";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "fake-key";
  process.env.RESEND_FROM = "Test <test@crazylarrys.test>";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Every recipient any provider call was made to. */
function allProviderRecipients(): string[] {
  return fetchMock.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)).to as string[]);
}

// ---- fixture values: what each one yields for its channel ----------------
type V = { label: string; raw: string | undefined };
const PHONE_VALUES: (V & { sms: string | null })[] = [
  { label: "unset", raw: undefined, sms: null },
  { label: "blank", raw: "   ", sms: null },
  { label: "usable", raw: "(614) 555-9999", sms: "+16145559999" },
  { label: "wrong shape", raw: "call me", sms: null },
  { label: "reserved", raw: "614-555-0101", sms: null },
  { label: "an email", raw: "phone@crazylarrys.test", sms: null },
];
const EMAIL_VALUES: (V & { email: string | null })[] = [
  { label: "unset", raw: undefined, email: null },
  { label: "blank", raw: " ", email: null },
  { label: "usable", raw: " tester@crazylarrys.test ", email: "tester@crazylarrys.test" },
  { label: "wrong shape", raw: "tester-at-nowhere", email: null },
  { label: "no domain", raw: "tester@nowhere", email: null },
  { label: "reserved", raw: "tester@example.com", email: null },
  { label: "a phone", raw: "6145557777", email: null },
];
const TO_VALUES: (V & { sms: string | null; email: string | null })[] = [
  { label: "unset", raw: undefined, sms: null, email: null },
  { label: "blank", raw: "  ", sms: null, email: null },
  { label: "phone", raw: "6145558888", sms: "+16145558888", email: null },
  { label: "email", raw: "old@crazylarrys.test", sms: null, email: "old@crazylarrys.test" },
  { label: "wrong shape", raw: "garbage", sms: null, email: null },
  { label: "bad email", raw: "old@nowhere", sms: null, email: null },
  { label: "reserved phone", raw: "614-555-0102", sms: null, email: null },
  { label: "reserved email", raw: "old@example.com", sms: null, email: null },
];

const COMBOS = PHONE_VALUES.flatMap((p) => EMAIL_VALUES.flatMap((e) => TO_VALUES.map((t) => ({ p, e, t }))));

describe("test mode: every combination of the three variables", () => {
  it(`covers ${COMBOS.length} combinations`, () => {
    expect(COMBOS.length).toBe(PHONE_VALUES.length * EMAIL_VALUES.length * TO_VALUES.length);
  });

  it.each(COMBOS.map((c) => [`PHONE=${c.p.label} EMAIL=${c.e.label} TO=${c.t.label}`, c] as const))("%s", async (_name, c) => {
    const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    set("CL_NOTIFICATIONS_TEST_PHONE", c.p.raw);
    set("CL_NOTIFICATIONS_TEST_EMAIL", c.e.raw);
    set("CL_NOTIFICATIONS_TEST_TO", c.t.raw);
    const anySet = [c.p.raw, c.e.raw, c.t.raw].some((v) => (v ?? "").trim() !== "");

    const { sendSms } = await import("./sms");
    const { sendEmail } = await import("./email");
    const sms = await sendSms(CUSTOMER_PHONE, "hello");
    const email = await sendEmail({ to: CUSTOMER_EMAIL, subject: "s", text: "t", html: "<p>t</p>" });
    const recipients = allProviderRecipients();

    expect(testModeOn()).toBe(anySet);
    if (!anySet) {
      expect(sms).toMatchObject({ ok: true, sentTo: CUSTOMER_PHONE, redirected: false });
      expect(email).toMatchObject({ ok: true, sentTo: CUSTOMER_EMAIL, redirected: false });
      return;
    }

    // Test mode: nothing ever reaches the customer, on either channel.
    expect(recipients).not.toContain(CUSTOMER_PHONE);
    expect(recipients).not.toContain(CUSTOMER_EMAIL);

    const wantSms = c.p.sms ?? c.t.sms; // the new variable first, then the old one
    const wantEmail = c.e.email ?? c.t.email;
    if (wantSms) {
      expect(sms).toMatchObject({ ok: true, sentTo: wantSms, redirected: true });
    } else {
      expect(sms.ok).toBe(false);
      expect(sms.sentTo).toBeUndefined();
      expect(sms.error).toContain("CL_NOTIFICATIONS_TEST_PHONE");
      expect(["test_mode", "not_configured"]).toContain(sms.category);
    }
    if (wantEmail) {
      expect(email).toMatchObject({ ok: true, sentTo: wantEmail, redirected: true });
    } else {
      expect(email.ok).toBe(false);
      expect(email.sentTo).toBeUndefined();
      expect(email.error).toContain("CL_NOTIFICATIONS_TEST_EMAIL");
      expect(["test_mode", "not_configured"]).toContain(email.category);
    }
    // Every provider call went to a test target, and only those.
    expect([...recipients].sort()).toEqual([wantSms, wantEmail].filter(Boolean).sort());
    // The reason never carries a configured value.
    for (const r of [sms.error ?? "", email.error ?? ""]) {
      for (const v of [c.p.raw, c.e.raw, c.t.raw]) if (v && v.trim()) expect(r).not.toContain(v.trim());
    }
  });
});

describe("only the old CL_NOTIFICATIONS_TEST_TO: unchanged behaviour", () => {
  async function both() {
    const { sendSms } = await import("./sms");
    const { sendEmail } = await import("./email");
    return {
      sms: await sendSms(CUSTOMER_PHONE, "hello"),
      email: await sendEmail({ to: CUSTOMER_EMAIL, subject: "s", text: "t", html: "<p>t</p>" }),
    };
  }
  it("a phone: texts go to it; email skipped as test_mode", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "6145558888";
    const { sms, email } = await both();
    expect(sms).toMatchObject({ ok: true, sentTo: "+16145558888", redirected: true });
    expect(email).toMatchObject({ ok: false, skipped: true, category: "test_mode" });
  });
  it("an email: emails go to it; SMS skipped as test_mode", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "old@crazylarrys.test";
    const { sms, email } = await both();
    expect(email).toMatchObject({ ok: true, sentTo: "old@crazylarrys.test", redirected: true });
    expect(sms).toMatchObject({ ok: false, skipped: true, category: "test_mode" });
  });
  it("not a number: SMS fails as not_configured (not skipped); email skipped as test_mode", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "garbage";
    const { sms, email } = await both();
    expect(sms).toMatchObject({ ok: false, skipped: false, category: "not_configured" });
    expect(email).toMatchObject({ ok: false, skipped: true, category: "test_mode" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reserved targets are refused as not_configured", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "614-555-0102";
    expect((await both()).sms).toMatchObject({ ok: false, category: "not_configured" });
    process.env.CL_NOTIFICATIONS_TEST_TO = "old@example.com";
    expect((await both()).email).toMatchObject({ ok: false, category: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("notifications_log: original_recipient with the new variables", () => {
  async function run() {
    const { notifyBookingConfirmation } = await import("./notify");
    await notifyBookingConfirmation(BOOKING.id);
    return { sms: inserted.find((r) => r.channel === "sms")!, email: inserted.find((r) => r.channel === "email")! };
  }
  it("both set: each logged with the test target as recipient and the customer as original", async () => {
    process.env.CL_NOTIFICATIONS_TEST_PHONE = "6145559999";
    process.env.CL_NOTIFICATIONS_TEST_EMAIL = "tester@crazylarrys.test";
    const { sms, email } = await run();
    expect(sms).toMatchObject({ delivery_status: "sent", recipient: "+16145559999", original_recipient: CUSTOMER_PHONE });
    expect(email).toMatchObject({ delivery_status: "sent", recipient: "tester@crazylarrys.test", original_recipient: CUSTOMER_EMAIL });
  });
  it("new variables win over CL_NOTIFICATIONS_TEST_TO", async () => {
    process.env.CL_NOTIFICATIONS_TEST_PHONE = "6145559999";
    process.env.CL_NOTIFICATIONS_TEST_EMAIL = "tester@crazylarrys.test";
    process.env.CL_NOTIFICATIONS_TEST_TO = "old@crazylarrys.test";
    const { email } = await run();
    expect(email).toMatchObject({ recipient: "tester@crazylarrys.test", original_recipient: CUSTOMER_EMAIL });
  });
  it("only the phone set: email logged as skipped test_mode, naming CL_NOTIFICATIONS_TEST_EMAIL, not redirected", async () => {
    process.env.CL_NOTIFICATIONS_TEST_PHONE = "6145559999";
    const { sms, email } = await run();
    expect(sms).toMatchObject({ delivery_status: "sent", recipient: "+16145559999", original_recipient: CUSTOMER_PHONE });
    expect(email).toMatchObject({ delivery_status: "skipped", failure_category: "test_mode", recipient: CUSTOMER_EMAIL, original_recipient: null });
    expect(String(email.error)).toContain("CL_NOTIFICATIONS_TEST_EMAIL is not set");
    expect(allProviderRecipients()).toEqual(["+16145559999"]);
  });
  it("a wrongly shaped test phone: SMS logged as failed not_configured, naming the variable; not sent", async () => {
    process.env.CL_NOTIFICATIONS_TEST_PHONE = "call me";
    process.env.CL_NOTIFICATIONS_TEST_EMAIL = "tester@crazylarrys.test";
    const { sms } = await run();
    expect(sms).toMatchObject({ delivery_status: "failed", failure_category: "not_configured", original_recipient: null });
    expect(String(sms.error)).toContain("CL_NOTIFICATIONS_TEST_PHONE is not a valid US number");
    expect(allProviderRecipients()).toEqual(["tester@crazylarrys.test"]);
  });
});

describe("Settings warnings for the test variables", () => {
  const base = { NODE_ENV: "test", CL_PAY_LINK_TOKEN_KEY: "k".repeat(32), CL_NOTIFICATIONS_ENABLED: "1" } as const;
  it("both new variables set and usable: test mode on, nothing half-configured", () => {
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_PHONE: "6145559999", CL_NOTIFICATIONS_TEST_EMAIL: "t@crazylarrys.test" })).toEqual(["test_split_on"]);
  });
  it("half-configured pair: says which half", () => {
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_PHONE: "6145559999" })).toEqual(["test_split_on", "test_email_unusable"]);
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_EMAIL: "t@crazylarrys.test" })).toEqual(["test_split_on", "test_phone_unusable"]);
  });
  it("a wrongly shaped or reserved new value counts as missing", () => {
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_PHONE: "614-555-0101", CL_NOTIFICATIONS_TEST_EMAIL: "t@crazylarrys.test" })).toEqual([
      "test_split_on",
      "test_phone_unusable",
    ]);
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_PHONE: "6145559999", CL_NOTIFICATIONS_TEST_EMAIL: "nope" })).toEqual([
      "test_split_on",
      "test_email_unusable",
    ]);
  });
  it("the old variable still set alongside the new ones", () => {
    expect(
      envWarnings({ ...base, CL_NOTIFICATIONS_TEST_TO: "old@crazylarrys.test", CL_NOTIFICATIONS_TEST_PHONE: "6145559999", CL_NOTIFICATIONS_TEST_EMAIL: "t@crazylarrys.test" }),
    ).toEqual(["test_redirect_on", "test_split_on"]);
  });
  it("only the old variable: exactly as before", () => {
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_TO: "old@crazylarrys.test" })).toEqual(["test_redirect_on"]);
  });
  it("blank values don't count; values are never returned", () => {
    expect(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_PHONE: "  ", CL_NOTIFICATIONS_TEST_EMAIL: "" })).toEqual([]);
    const out = JSON.stringify(envWarnings({ ...base, CL_NOTIFICATIONS_TEST_PHONE: "6145559999", CL_NOTIFICATIONS_TEST_EMAIL: "secret-me@x.test" }));
    expect(out).not.toContain("secret-me");
    expect(out).not.toContain("6145559999");
  });
});
