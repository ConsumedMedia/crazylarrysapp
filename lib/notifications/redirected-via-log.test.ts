/**
 * notifications_log.redirected_via (migration 20261112000000): which test
 * variable redirected a send, and the writer's fallback when the column isn't
 * there yet. Unit test: fetch is stubbed (no Quo/Resend call can leave the
 * machine) and the service client is a fake that captures inserts.
 *
 * Fixtures are not reserved contacts (example.com, 555-01xx): the send layer
 * refuses those.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TEST_EMAIL_VAR, TEST_PHONE_VAR, TEST_TO_VAR } from "./test-mode";

type InsertResult = { error: { code?: string; message: string } | null };
const inserts: Record<string, unknown>[] = [];
/** How the fake database answers each insert, decided by the row (not call order). */
const OK: InsertResult = { error: null };
let respond: (row: Record<string, unknown>) => InsertResult = () => OK;

const BOOKING = {
  id: "00000000-0000-0000-0000-0000000000b3",
  size_requested: "20yd",
  delivery_date: "2026-11-20",
  pickup_date: "2026-11-27",
  delivery_address: "1 Test St, Columbus, OH 43004",
  placement_notes: null,
  total: 401.05,
  payment_status: "paid",
  customers: { full_name: "Test Customer", email: "customer@crazylarrys.test", phone: "614-555-0200", sms_consent: true },
};

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === "notifications_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserts.push(row);
            return respond(row);
          },
        };
      }
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: BOOKING, error: null }) };
      return chain;
    },
  }),
}));

const ENV_KEYS = [
  "CL_NOTIFICATIONS_ENABLED",
  TEST_PHONE_VAR,
  TEST_EMAIL_VAR,
  TEST_TO_VAR,
  "QUO_API_KEY",
  "QUO_FROM_NUMBER",
  "RESEND_API_KEY",
  "RESEND_FROM",
] as const;
const saved: Record<string, string | undefined> = {};
const fetchMock = vi.fn(async (url: string) =>
  new Response(JSON.stringify(String(url).includes("quo") ? { data: { id: "q1" } } : { id: "r1" }), { status: 202 }),
);

beforeEach(() => {
  inserts.length = 0;
  respond = () => OK;
  fetchMock.mockClear();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
  process.env.QUO_API_KEY = "fake-key";
  process.env.QUO_FROM_NUMBER = "+13805550000";
  process.env.RESEND_API_KEY = "fake-key";
  process.env.RESEND_FROM = "Test <test@crazylarrys.test>";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function confirm() {
  const { notifyBookingConfirmation } = await import("./notify");
  await notifyBookingConfirmation(BOOKING.id);
  return { sms: inserts.find((r) => r.channel === "sms"), email: inserts.find((r) => r.channel === "email") };
}

describe("loggedRedirectVia", () => {
  const cases: Array<[string, "sms" | "email", { redirected?: boolean; redirectedVia?: string }, string | null]> = [
    ["SMS via TEST_PHONE", "sms", { redirected: true, redirectedVia: TEST_PHONE_VAR }, TEST_PHONE_VAR],
    ["email via TEST_EMAIL", "email", { redirected: true, redirectedVia: TEST_EMAIL_VAR }, TEST_EMAIL_VAR],
    ["SMS via TEST_TO", "sms", { redirected: true, redirectedVia: TEST_TO_VAR }, TEST_TO_VAR],
    ["email via TEST_TO", "email", { redirected: true, redirectedVia: TEST_TO_VAR }, TEST_TO_VAR],
    ["SMS claiming TEST_EMAIL (wrong channel)", "sms", { redirected: true, redirectedVia: TEST_EMAIL_VAR }, null],
    ["email claiming TEST_PHONE (wrong channel)", "email", { redirected: true, redirectedVia: TEST_PHONE_VAR }, null],
    ["an unknown name", "sms", { redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_X" }, null],
    ["a lowercase name", "sms", { redirected: true, redirectedVia: TEST_PHONE_VAR.toLowerCase() }, null],
    ["a value instead of a name", "sms", { redirected: true, redirectedVia: "+16145559999" }, null],
    ["redirected, name unknown", "sms", { redirected: true }, null],
    ["a name on a send that wasn't redirected", "sms", { redirected: false, redirectedVia: TEST_PHONE_VAR }, null],
    ["nothing", "email", {}, null],
  ];
  it.each(cases)("%s", async (_label, channel, result, want) => {
    const { loggedRedirectVia } = await import("./notify");
    expect(loggedRedirectVia(channel, result)).toBe(want);
  });
});

describe("each send logs the variable that redirected it", () => {
  it("TEST_PHONE and TEST_EMAIL: each channel logs its own", async () => {
    process.env[TEST_PHONE_VAR] = "6145559999";
    process.env[TEST_EMAIL_VAR] = "tester@crazylarrys.test";
    const { sms, email } = await confirm();
    expect(sms).toMatchObject({ delivery_status: "sent", original_recipient: "+16145550200", redirected_via: TEST_PHONE_VAR });
    expect(email).toMatchObject({ delivery_status: "sent", original_recipient: "customer@crazylarrys.test", redirected_via: TEST_EMAIL_VAR });
  });

  it("only TEST_TO (an email): the email logs TEST_TO, the skipped SMS logs null", async () => {
    process.env[TEST_TO_VAR] = "tester@crazylarrys.test";
    const { sms, email } = await confirm();
    expect(email).toMatchObject({ delivery_status: "sent", redirected_via: TEST_TO_VAR });
    expect(sms).toMatchObject({ delivery_status: "skipped", failure_category: "test_mode", original_recipient: null, redirected_via: null });
  });

  it("TEST_PHONE wins over a phone TEST_TO", async () => {
    process.env[TEST_PHONE_VAR] = "6145559999";
    process.env[TEST_TO_VAR] = "6145558888";
    const { sms } = await confirm();
    expect(sms).toMatchObject({ recipient: "+16145559999", redirected_via: TEST_PHONE_VAR });
  });

  it("no test variables: both rows null", async () => {
    const { sms, email } = await confirm();
    expect(sms).toMatchObject({ original_recipient: null, redirected_via: null });
    expect(email).toMatchObject({ original_recipient: null, redirected_via: null });
  });

  it("the column holds a name, never the test address or number", async () => {
    process.env[TEST_PHONE_VAR] = "6145559999";
    process.env[TEST_EMAIL_VAR] = "tester@crazylarrys.test";
    await confirm();
    for (const r of inserts) expect(String(r.redirected_via)).not.toMatch(/@|\d/);
  });
});

describe("writer fallback: code deployed before the migration", () => {
  const MISSING = { code: "PGRST204", message: "Could not find the 'redirected_via' column of 'notifications_log' in the schema cache" };

  it("PGRST204 for redirected_via: retries once without the field, keeps the row, warns", async () => {
    process.env[TEST_TO_VAR] = "tester@crazylarrys.test";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = (row) => ("redirected_via" in row ? { error: MISSING } : OK);
    await confirm();
    expect(inserts).toHaveLength(4);
    const [first, retry] = inserts.filter((r) => r.channel === "email");
    expect(first).toHaveProperty("redirected_via", TEST_TO_VAR);
    expect(retry).not.toHaveProperty("redirected_via");
    expect(retry).toMatchObject({ channel: "email", delivery_status: "sent", original_recipient: "customer@crazylarrys.test" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("42703 for redirected_via is treated the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const UNDEFINED = { code: "42703", message: 'column "redirected_via" of relation "notifications_log" does not exist' };
    respond = (row) => ("redirected_via" in row && row.channel === "email" ? { error: UNDEFINED } : OK);
    await confirm();
    expect(inserts).toHaveLength(3); // the email retried, the SMS inserted first time
    expect(inserts.filter((r) => !("redirected_via" in r)).map((r) => r.channel)).toEqual(["email"]);
  });

  it("any other insert error is not retried (a check or key failure stays one attempt)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respond = (row) => ({
      error:
        row.channel === "sms"
          ? { code: "23514", message: 'new row violates check constraint "notifications_log_redirected_via_check"' }
          : { code: "23503", message: "insert or update violates foreign key constraint" },
    });
    await confirm();
    expect(inserts).toHaveLength(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a missing OTHER column is not retried", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const OTHER = { code: "PGRST204", message: "Could not find the 'failure_category' column of 'notifications_log' in the schema cache" };
    respond = (row) => (row.channel === "sms" ? { error: OTHER } : OK);
    await confirm();
    expect(inserts).toHaveLength(2);
  });

  it("a failed retry is reported, and the send still doesn't throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = (row) => ({ error: "redirected_via" in row ? MISSING : { code: "08006", message: "connection lost" } });
    await expect(confirm()).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith("[notify] notifications_log insert failed:", "connection lost");
  });
});
