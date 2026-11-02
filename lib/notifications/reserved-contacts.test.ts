/**
 * Unit test — no network, no database. `fetch` is stubbed and asserted never
 * to be called for a reserved contact, with sends switched on for this process.
 *
 * Rule: the send layer never delivers to a reserved fictional contact
 * (example.com / .net / .org, NXX-555-0100..0199) — not as the intended
 * recipient, and not as the CL_NOTIFICATIONS_TEST_TO redirect target.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isReservedEmail, isReservedPhone } from "./reserved";
import { sendEmail } from "./email";
import { sendSms } from "./sms";

const ENV_KEYS = [
  "CL_NOTIFICATIONS_ENABLED",
  "CL_NOTIFICATIONS_TEST_TO",
  "QUO_API_KEY",
  "QUO_FROM_NUMBER",
  "RESEND_API_KEY",
  "RESEND_FROM",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const fetchMock = vi.fn(async (url: string) => {
  const body = String(url).includes("quo") ? { data: { id: "quo-msg-1" } } : { id: "resend-msg-1" };
  return new Response(JSON.stringify(body), { status: 202 });
});

beforeEach(() => {
  fetchMock.mockClear();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  delete process.env.CL_NOTIFICATIONS_TEST_TO;
  process.env.QUO_API_KEY = "fake-key";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "fake-key";
  process.env.RESEND_FROM = "Test <noreply@crazylarrys.test>";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const mail = (to: string) => sendEmail({ to, subject: "s", text: "t", html: "<p>t</p>" });

describe("isReservedEmail", () => {
  it.each([
    "customer@example.com",
    "Rebecca.Lund@EXAMPLE.COM",
    "x@example.net",
    "x@example.org",
    "x@mail.example.com",
    "  padded@example.com  ",
  ])("reserved: %s", (a) => expect(isReservedEmail(a)).toBe(true));

  it.each([
    "nathan@crossingriverstudios.com",
    "x@notexample.com",
    "x@example.com.au",
    "x@examples.com",
    "example.com@gmail.com",
    "seed-owner@crazylarrys.test",
    "",
    null,
  ])("not reserved: %s", (a) => expect(isReservedEmail(a)).toBe(false));
});

describe("isReservedPhone", () => {
  it.each(["614-555-0100", "(614) 555-0199", "+16145550142", "16145550150", "212 555 0123"])(
    "reserved: %s",
    (p) => expect(isReservedPhone(p)).toBe(true),
  );
  it.each(["614-555-0200", "614-555-0099", "614-555-1234", "614-769-0100", "555-0100", "", null])(
    "not reserved: %s",
    (p) => expect(isReservedPhone(p)).toBe(false),
  );
});

describe("sendEmail never mails a reserved address", () => {
  it("skips a reserved intended recipient without calling Resend", async () => {
    const r = await mail("customer@example.com");
    expect(r).toMatchObject({ ok: false, skipped: true, category: "recipient_missing" });
    expect(r.error).toMatch(/reserved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a reserved intended recipient even when TEST_TO would redirect it", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "tester@crazylarrys.test";
    const r = await mail("customer@example.com");
    expect(r).toMatchObject({ ok: false, skipped: true, category: "recipient_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a reserved TEST_TO target", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "tester@example.com";
    const r = await mail("real.customer@gmail.com");
    expect(r).toMatchObject({ ok: false, category: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends to an ordinary address", async () => {
    const r = await mail("real.customer@gmail.com");
    expect(r).toMatchObject({ ok: true, sentTo: "real.customer@gmail.com", redirected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disabled still wins: a reserved address is reported as disabled when sends are off", async () => {
    process.env.CL_NOTIFICATIONS_ENABLED = "0";
    const r = await mail("customer@example.com");
    expect(r).toMatchObject({ skipped: true, category: "disabled" });
  });
});

describe("sendSms never texts a reserved number", () => {
  it("skips a reserved intended number without calling Quo", async () => {
    const r = await sendSms("+16145550100", "hi");
    expect(r).toMatchObject({ ok: false, skipped: true, category: "recipient_missing" });
    expect(r.error).toMatch(/reserved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a reserved intended number even when TEST_TO would redirect it", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "6145559999";
    const r = await sendSms("+16145550100", "hi");
    expect(r).toMatchObject({ ok: false, skipped: true, category: "recipient_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a reserved TEST_TO target", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "614-555-0101";
    const r = await sendSms("+16147690000", "hi");
    expect(r).toMatchObject({ ok: false, category: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends to an ordinary number", async () => {
    const r = await sendSms("+16145550200", "hi");
    expect(r).toMatchObject({ ok: true, sentTo: "+16145550200", redirected: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
