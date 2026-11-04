/**
 * Staff pay-link library + the Book action, through the REAL notify.ts with
 * fetch stubbed. Two jobs:
 *   1. createPayLinkBooking / resendPayLink: session client only, the contact
 *      rule, what staff are told was sent, the link only when nothing went out.
 *   2. The plaintext link never appears in a URL, redirect, revalidated path,
 *      log row, thrown error, action error or console output — on the happy
 *      path and on every failure path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const LINK = `/pay/${TOKEN}`;

// ---- session client: the RPCs ----
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResult;
    },
  }),
}));

// ---- service client: notify's booking read + notifications_log ----
const logRows: Record<string, unknown>[] = [];
let customer: Record<string, unknown>;
let bookingReadThrows: Error | null = null;
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "notifications_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            logRows.push(row);
            return { error: null };
          },
        };
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (bookingReadThrows) throw bookingReadThrows;
          return {
            data: {
              id: "bk-1",
              size_requested: "15yd",
              delivery_date: "2026-11-10",
              pickup_date: "2026-11-15",
              delivery_address: "1 Test St, Columbus, OH 43004",
              placement_notes: null,
              total: 375.38,
              payment_status: "unpaid",
              customers: customer,
            },
            error: null,
          };
        },
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/auth/requireStaff", () => ({
  assertStaff: async () => ({ userId: "staff-1", role: "owner", email: null, fullName: null }),
  NotAuthorizedError: class NotAuthorizedError extends Error {},
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

// ---- providers: fetch ----
type FetchMode = "ok" | "echo_400" | "throw_with_url";
let fetchMode: FetchMode = "ok";
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = String(init?.body ?? "");
  if (fetchMode === "throw_with_url") throw new Error(`socket hang up while sending ${body.slice(0, 400)}`);
  if (fetchMode === "echo_400") return new Response(`rejected: ${body.slice(0, 400)}`, { status: 400 });
  return new Response(JSON.stringify({ id: "r1", data: { id: "q1" } }), { status: 202 });
});

// ---- console capture ----
const consoleOut: string[] = [];
const ENV = ["CL_NOTIFICATIONS_ENABLED", "CL_NOTIFICATIONS_TEST_TO", "QUO_API_KEY", "QUO_FROM_NUMBER", "RESEND_API_KEY", "RESEND_FROM", "NEXT_PUBLIC_SITE_URL", "CL_PAY_LINK_TOKEN_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  rpcCalls.length = 0;
  logRows.length = 0;
  consoleOut.length = 0;
  revalidatePath.mockClear();
  redirect.mockClear();
  fetchMock.mockClear();
  fetchMode = "ok";
  bookingReadThrows = null;
  rpcResult = { data: [{ booking_id: "bk-1", token: TOKEN }], error: null };
  customer = { full_name: "Pat Example", email: "pat@crazylarrys.test", phone: "614-555-0200", sms_consent: true };
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  delete process.env.CL_NOTIFICATIONS_TEST_TO;
  process.env.QUO_API_KEY = "k";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "k";
  process.env.RESEND_FROM = "T <noreply@crazylarrys.test>";
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.CL_PAY_LINK_TOKEN_KEY;
  vi.stubGlobal("fetch", fetchMock);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      consoleOut.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const tomorrowPlus = () => {
  const d = new Date(Date.now() + 5 * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const input = (over: Record<string, unknown> = {}) => ({
  size: "15yd" as const,
  deliveryDate: tomorrowPlus(),
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43004",
  contactName: "Pat Example",
  contactEmail: "pat@crazylarrys.test",
  contactPhone: "614-555-0200",
  smsConsent: true,
  ...over,
});
function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  const base: Record<string, string> = {
    size: "15yd",
    deliveryDate: tomorrowPlus(),
    street: "1 Test St",
    city: "Columbus",
    state: "OH",
    zip: "43004",
    contactName: "Pat Example",
    contactEmail: "pat@crazylarrys.test",
    contactPhone: "614-555-0200",
    smsConsent: "on",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== "") fd.set(k, v);
  return fd;
}

/** Everything that left the code other than the provider request bodies and the returned state. */
function everythingButTheLink(extra: unknown[] = []) {
  return JSON.stringify({
    logRows,
    consoleOut,
    revalidated: revalidatePath.mock.calls,
    redirected: redirect.mock.calls,
    fetchUrls: fetchMock.mock.calls.map(([u]) => u),
    extra,
  });
}

describe("createPayLinkBooking", () => {
  it("contact rule: no email and a phone without consent is refused before the database", async () => {
    const { createPayLinkBooking } = await import("./staff");
    await expect(createPayLinkBooking(input({ contactEmail: "", smsConsent: false }))).rejects.toThrow(/Add an email/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("calls staff_create_pay_link_booking on the session, with verbal consent and the key only when set", async () => {
    const { createPayLinkBooking } = await import("./staff");
    await createPayLinkBooking(input());
    expect(rpcCalls[0].name).toBe("staff_create_pay_link_booking");
    expect(rpcCalls[0].args.p_verbal_sms_consent).toBe(true);
    expect("p_token_key" in rpcCalls[0].args).toBe(false);

    rpcCalls.length = 0;
    process.env.CL_PAY_LINK_TOKEN_KEY = "k".repeat(40);
    await createPayLinkBooking(input());
    expect(rpcCalls[0].args.p_token_key).toBe("k".repeat(40));
  });

  it("something sent: reports each channel, and no link comes back", async () => {
    const { createPayLinkBooking } = await import("./staff");
    const r = await createPayLinkBooking(input());
    expect(r.bookingId).toBe("bk-1");
    expect(r.sent.map((o) => `${o.channel}:${o.status}`).sort()).toEqual(["email:sent", "sms:sent"]);
    expect(r.url).toBeNull();
  });

  it("nothing sent (no consent, no email): the link comes back once, for the screen", async () => {
    customer = { ...customer, email: null, sms_consent: false };
    const { createPayLinkBooking } = await import("./staff");
    const r = await createPayLinkBooking(input());
    expect(r.sent).toEqual([{ channel: "sms", status: "skipped", category: "no_consent", redirected: false }]);
    expect(r.url).toBe(`https://app.crazylarrysdumpsters.com${LINK}`);
  });

  it("TEST_TO redirect is reported as redirected", async () => {
    process.env.CL_NOTIFICATIONS_TEST_TO = "tester@crazylarrys.test";
    const { createPayLinkBooking } = await import("./staff");
    const r = await createPayLinkBooking(input());
    expect(r.sent.find((o) => o.channel === "email")).toMatchObject({ status: "sent", redirected: true });
    expect(r.url).toBeNull();
  });

  it("RPC refusal hints become staff words", async () => {
    rpcResult = { data: null, error: { code: "23514", hint: "pay_links_disabled", message: "x" } };
    const { createPayLinkBooking } = await import("./staff");
    await expect(createPayLinkBooking(input())).rejects.toThrow("Pay links are turned off in Settings.");
  });
});

describe("resendPayLink", () => {
  it("issue_pay_link on the session; nothing sent -> the new link once", async () => {
    rpcResult = { data: TOKEN, error: null };
    customer = { ...customer, email: null, phone: null };
    const { resendPayLink } = await import("./staff");
    const r = await resendPayLink("bk-1");
    expect(rpcCalls[0]).toEqual({ name: "issue_pay_link", args: { p_booking_id: "bk-1" } });
    expect(r.url).toContain(LINK);
  });

  it("sent -> no link back", async () => {
    rpcResult = { data: TOKEN, error: null };
    const { resendPayLink } = await import("./staff");
    expect((await resendPayLink("bk-1")).url).toBeNull();
  });

  it("qbo_invoice_pending refusal reads in staff words", async () => {
    rpcResult = { data: null, error: { code: "23514", hint: "qbo_invoice_pending", message: "x" } };
    const { resendPayLink } = await import("./staff");
    await expect(resendPayLink("bk-1")).rejects.toThrow(/QuickBooks invoice is still open/);
  });
});

describe("the plaintext link never leaks", () => {
  it("happy path through the action: only state.url could hold it, and here it is null", async () => {
    const { createPayLinkBookingAction } = await import("@/app/(admin)/bookings/new/pay-link-actions");
    const state = await createPayLinkBookingAction({ ok: false }, form());
    expect(state).toMatchObject({ ok: true, bookingId: "bk-1", url: null });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath.mock.calls).toEqual([["/bookings"]]);
    expect(everythingButTheLink()).not.toContain(TOKEN);
    // It did reach the customer.
    expect(fetchMock.mock.calls.some(([, i]) => String(i?.body).includes(TOKEN))).toBe(true);
  });

  it("providers reject and echo the message back: logged redacted, console clean, link on screen only", async () => {
    fetchMode = "echo_400";
    const { createPayLinkBookingAction } = await import("@/app/(admin)/bookings/new/pay-link-actions");
    const state = await createPayLinkBookingAction({ ok: false }, form());
    expect(state.ok).toBe(true);
    expect(state.sent?.every((o) => o.status === "failed")).toBe(true);
    expect(state.url).toContain(LINK);
    expect(logRows.length).toBe(2);
    expect(everythingButTheLink([state.error, state.sent])).not.toContain(TOKEN);
  });

  it("providers throw with the message in the error: console and log clean", async () => {
    fetchMode = "throw_with_url";
    const { createPayLinkBookingAction } = await import("@/app/(admin)/bookings/new/pay-link-actions");
    const state = await createPayLinkBookingAction({ ok: false }, form());
    expect(state.url).toContain(LINK);
    expect(everythingButTheLink([state.error, state.sent])).not.toContain(TOKEN);
  });

  it("notify's own read fails with the link in the message: console scrubbed, link on screen", async () => {
    bookingReadThrows = new Error(`boom near https://x.test${LINK}`);
    const { createPayLinkBookingAction } = await import("@/app/(admin)/bookings/new/pay-link-actions");
    const state = await createPayLinkBookingAction({ ok: false }, form());
    expect(state.sent).toEqual([]);
    expect(state.url).toContain(LINK);
    expect(consoleOut.length).toBeGreaterThan(0);
    expect(everythingButTheLink([state.error])).not.toContain(TOKEN);
  });

  it("an RPC error that somehow carries a token: the action's error is scrubbed", async () => {
    rpcResult = { data: null, error: { code: "XX000", message: `weird failure ${TOKEN}` } };
    const { createPayLinkBookingAction } = await import("@/app/(admin)/bookings/new/pay-link-actions");
    const state = await createPayLinkBookingAction({ ok: false }, form());
    expect(state.ok).toBe(false);
    expect(state.url).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(everythingButTheLink()).not.toContain(TOKEN);
  });

  it("an unexpected exception after the link exists: generic error on screen, scrubbed console, no link anywhere", async () => {
    rpcResult = { data: [{ booking_id: "bk-1", token: TOKEN }], error: null };
    revalidatePath.mockImplementationOnce(() => {
      throw new Error(`cache exploded at ${LINK}`);
    });
    const { createPayLinkBookingAction } = await import("@/app/(admin)/bookings/new/pay-link-actions");
    const state = await createPayLinkBookingAction({ ok: false }, form());
    expect(state.ok).toBe(false);
    expect(state.error).toMatch(/Check the bookings list/);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(consoleOut.join(" ")).toContain("cache exploded");
    expect(everythingButTheLink()).not.toContain(TOKEN);
  });

  it("thrown errors from the library never carry the token", async () => {
    rpcResult = { data: null, error: { code: "XX000", message: `db said ${TOKEN}` } };
    const { createPayLinkBooking, resendPayLink } = await import("./staff");
    const caught: string[] = [];
    for (const fn of [() => createPayLinkBooking(input()), () => resendPayLink("bk-1")]) {
      try {
        await fn();
      } catch (e) {
        caught.push((e as Error).message);
      }
    }
    expect(caught).toHaveLength(2);
    for (const m of caught) {
      expect(m).not.toContain(TOKEN);
      expect(m).toContain("…");
    }
    expect(everythingButTheLink()).not.toContain(TOKEN);
  });
});
