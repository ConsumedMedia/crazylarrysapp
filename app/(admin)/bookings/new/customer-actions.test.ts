/**
 * The customer-search server actions never put a search term or any customer
 * data in the server log: not on success, not when the database errors with
 * those values in its message, not on an unexpected exception carrying them,
 * not when a non-staff session is refused. Failures return no data either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeSupabase, type Rows } from "@/test/fake-supabase";

const NAME = "Pat Example";
const PHONE = "614-555-0142";
const EMAIL = "pat@crazylarrys.test";
const OTHER = "Lee Prepaid";
const OTHER_EMAIL = "lee@crazylarrys.test";
const ADDRESS = "1 Test St, Columbus, OH 43004";
const SECRETS = [NAME, "Pat", PHONE, "6145550142", "0142", EMAIL, OTHER, OTHER_EMAIL, ADDRESS, "Example Roofing"];

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const tables: Rows = {
  customers: [
    { id: P1, full_name: NAME, phone: PHONE, email: EMAIL, company_name: "Example Roofing", sms_consent: true, created_at: "2026-10-01" },
    { id: P2, full_name: OTHER, phone: null, email: OTHER_EMAIL, company_name: null, sms_consent: false, created_at: "2026-10-02" },
  ],
  bookings: [{ id: "b1", customer_id: P1, delivery_address: ADDRESS, delivery_date: "2026-10-01" }],
  consent_records: [],
};

let mode: "ok" | "db_error" | "throw" = "ok";
let staff = true;
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    if (mode === "throw") throw new Error(`exploded while searching ${NAME} ${PHONE} ${EMAIL}`);
    return fakeSupabase(tables, {
      failOn: () => (mode === "db_error" ? { code: "22P02", message: `bad input "${NAME}" ${PHONE} ${EMAIL} ${ADDRESS}` } : null),
    }).client;
  },
}));
vi.mock("@/lib/auth/requireStaff", () => {
  class NotAuthorizedError extends Error {}
  return {
    NotAuthorizedError,
    assertStaff: async () => {
      if (!staff) throw new NotAuthorizedError(`not staff (was looking for ${NAME})`);
      return { userId: "s", role: "staff" };
    },
  };
});

const logged: string[] = [];
beforeEach(() => {
  mode = "ok";
  staff = true;
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

async function runAll() {
  const { searchCustomersAction, pickCustomerAction, emailOwnerAction } = await import("./customer-actions");
  return [
    await searchCustomersAction(NAME),
    await searchCustomersAction(PHONE),
    await pickCustomerAction(P1),
    await emailOwnerAction(OTHER_EMAIL, P1),
  ];
}

const clean = (s: string) => SECRETS.every((x) => !s.includes(x));

describe("customer search actions: nothing searched for or found reaches the log", () => {
  it("success: returns data, logs nothing", async () => {
    const r = await runAll();
    expect(r[0]).toMatchObject({ ok: true });
    expect(r[3]).toEqual({ ok: true, name: OTHER });
    expect(logged).toEqual([]);
  });

  it("database error whose message echoes the term and customer data: logs a code only, returns no data", async () => {
    mode = "db_error";
    const r = await runAll();
    expect(r).toEqual([{ ok: false }, { ok: false }, { ok: false }, { ok: false }]);
    expect(logged.length).toBe(4);
    expect(logged.every(clean)).toBe(true);
    expect(logged[0]).toBe("[customer search] search failed: name_22P02");
  });

  it("unexpected exception carrying the data: logs 'unexpected' only", async () => {
    mode = "throw";
    const r = await runAll();
    expect(r.every((x) => x.ok === false)).toBe(true);
    expect(logged.length).toBe(4);
    expect(logged.every(clean)).toBe(true);
    expect(logged.every((l) => l.endsWith("failed: unexpected"))).toBe(true);
  });

  it("non-staff session: refused, logs 'not_staff' only", async () => {
    staff = false;
    const r = await runAll();
    expect(r.every((x) => x.ok === false)).toBe(true);
    expect(logged.every(clean)).toBe(true);
    expect(logged.every((l) => l.endsWith("failed: not_staff"))).toBe(true);
  });

  it("malformed ids are refused without touching the database or the log", async () => {
    mode = "throw";
    const { pickCustomerAction, emailOwnerAction } = await import("./customer-actions");
    expect(await pickCustomerAction("../etc")).toEqual({ ok: false });
    expect(await emailOwnerAction(OTHER_EMAIL, "nope")).toEqual({ ok: false });
    expect(logged).toEqual([]);
  });
});
