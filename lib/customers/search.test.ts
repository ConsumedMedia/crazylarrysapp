import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Rows } from "@/test/fake-supabase";
import {
  digitsOf,
  distinctAddresses,
  escapeLike,
  parseAddress,
  phoneLikePattern,
  phoneMatches,
  searchMode,
  SEARCH_LIMIT,
} from "./search-shared";

let tables: Rows;
let fake: ReturnType<typeof fakeSupabase>;
let failOn: ((t: string) => { code: string; message: string } | null) | undefined;
vi.mock("@/lib/supabase/server", () => ({ createClient: () => fake.client }));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    throw new Error("service_role must not be used for customer search");
  },
}));
let staff = true;
vi.mock("@/lib/auth/requireStaff", () => ({
  assertStaff: async () => {
    if (!staff) throw new Error("Staff access required");
    return { userId: "s", role: "staff" };
  },
  NotAuthorizedError: class NotAuthorizedError extends Error {},
}));

import { otherCustomerWithEmail, pickCustomer, searchCustomers } from "./search";

const C = (id: string, full_name: string, phone: string | null, email: string | null = null, extra: Record<string, unknown> = {}) => ({
  id,
  full_name,
  phone,
  email,
  company_name: null,
  sms_consent: false,
  created_at: `2026-10-${id.slice(-2)}T00:00:00Z`,
  ...extra,
});

beforeEach(() => {
  staff = true;
  failOn = undefined;
  tables = {
    customers: [
      C("c-01", "Pat Example", "614-555-0142", "pat@crazylarrys.test", { company_name: "Example Roofing", sms_consent: true }),
      C("c-02", "Patricia Long", "6145550199"),
      C("c-03", "Sam Pattern", "+1 (740) 555-0142"),
      C("c-04", "100% Juice_Co", "937-555-0000"),
      C("c-05", "Lee Prepaid", null, "lee@crazylarrys.test"),
      ...Array.from({ length: 12 }, (_, i) => C(`c-1${i}`, `Patsy ${String(i).padStart(2, "0")}`, null)),
    ],
    bookings: [
      { id: "b1", customer_id: "c-01", delivery_address: "1 Test St, Columbus, OH 43004", delivery_date: "2026-10-01" },
      { id: "b2", customer_id: "c-01", delivery_address: "9 Other Rd, Dublin, OH 43017", delivery_date: "2026-10-20" },
      { id: "b3", customer_id: "c-01", delivery_address: "1 test st, columbus, oh 43004 ", delivery_date: "2026-09-01" },
      { id: "b4", customer_id: "c-01", delivery_address: "Lot 4 behind the barn", delivery_date: "2026-10-25" },
      { id: "b5", customer_id: "c-01", delivery_address: "5 Fifth Ave, Worthington, OH 43085", delivery_date: "2026-08-01" },
      { id: "b6", customer_id: "c-02", delivery_address: "2 Two St, Columbus, OH 43004", delivery_date: "2026-10-02" },
    ],
    consent_records: [
      { customer_id: "c-01", granted: true, source: "phone_verbal", recorded_at: "2026-11-03T15:00:00Z" },
      { customer_id: "c-01", granted: true, source: "pay_page", recorded_at: "2026-10-01T15:00:00Z" },
    ],
  };
  fake = fakeSupabase(tables, { failOn: (t) => failOn?.(t) ?? null });
});

describe("pure helpers", () => {
  it("searchMode: 2+ letters for names, 3+ digits for phones", () => {
    expect(searchMode("p")).toEqual({ name: null, digits: null });
    expect(searchMode("pa")).toEqual({ name: "pa", digits: null });
    expect(searchMode("61")).toEqual({ name: null, digits: null });
    expect(searchMode("614")).toEqual({ name: null, digits: "614" });
    expect(searchMode("+1 (614) 555-0142").digits).toBe("16145550142");
  });
  it("escapeLike and the phone pattern", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(phoneLikePattern("16145550142")).toBe("%6%1%4%5%5%5%0%1%4%2%");
  });
  it("phoneMatches: last 10 for a full number, a run of digits for a partial", () => {
    expect(phoneMatches("+1 (614) 555-0142", "6145550142")).toBe(true);
    expect(phoneMatches("614-555-0142", "16145550142")).toBe(true);
    expect(phoneMatches("740-555-0142", "6145550142")).toBe(false);
    expect(phoneMatches("614-555-0142", "0142")).toBe(true);
    expect(phoneMatches("614-555-0142", "4142")).toBe(false);
    expect(phoneMatches(null, "0142")).toBe(false);
    expect(digitsOf("+1 (614) 555-0142")).toBe("16145550142");
  });
  it("addresses: split when possible, greyed (null parts) when not, 3 distinct newest first", () => {
    expect(parseAddress("1 Test St, Columbus, OH 43004")).toEqual({ street: "1 Test St", city: "Columbus", state: "OH", zip: "43004" });
    expect(parseAddress("Lot 4 behind the barn")).toBeNull();
    const opts = distinctAddresses(["Lot 4 behind the barn", "9 Other Rd, Dublin, OH 43017", "1 Test St, Columbus, OH 43004", "1 test st,  columbus, oh 43004", "5 Fifth Ave, Worthington, OH 43085"]);
    expect(opts.map((o) => o.label)).toEqual(["Lot 4 behind the barn", "9 Other Rd, Dublin, OH 43017", "1 Test St, Columbus, OH 43004"]);
    expect(opts[0].parts).toBeNull();
  });
});

describe("searchCustomers (staff session)", () => {
  it("refuses a non-staff session before any query", async () => {
    staff = false;
    await expect(searchCustomers("Pat")).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it("names its columns, never *", async () => {
    await searchCustomers("Pat");
    const sel = fake.calls.filter((c) => c.table === "customers" && c.op === "select");
    expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) expect(s.args[0]).toBe("id, full_name, phone, email, company_name, sms_consent");
    expect(fake.calls.find((c) => c.table === "bookings" && c.op === "select")?.args[0]).toBe("customer_id");
  });

  it("a name matches anywhere, case-insensitive; names starting with it rank first; at most 8", async () => {
    const hits = await searchCustomers("pat");
    expect(hits).toHaveLength(SEARCH_LIMIT);
    expect(hits[0].name).toBe("Pat Example");
    expect(hits.every((h) => h.name.toLowerCase().includes("pat"))).toBe(true);
  });

  it("every phone format, typed any way, finds the same customer by the last 10 digits", async () => {
    for (const typed of ["614-555-0142", "6145550142", "+1 (614) 555-0142", "1 614 555 0142"]) {
      expect((await searchCustomers(typed)).map((h) => h.id), typed).toEqual(["c-01"]);
    }
    expect((await searchCustomers("(740) 555-0142")).map((h) => h.id)).toEqual(["c-03"]);
  });

  it("partial digits must appear in a row", async () => {
    expect((await searchCustomers("0142")).map((h) => h.id).sort()).toEqual(["c-01", "c-03"]);
    expect(await searchCustomers("4142")).toEqual([]);
  });

  it("% and _ typed are literal, not wildcards", async () => {
    expect((await searchCustomers("0% Juice")).map((h) => h.id)).toEqual(["c-04"]);
    expect(await searchCustomers("0x Juice")).toEqual([]);
    expect((await searchCustomers("e_C")).map((h) => h.id)).toEqual(["c-04"]);
    expect(await searchCustomers("%%")).toEqual([]);
    expect(await searchCustomers("P%t")).toEqual([]);
  });

  it("booking counts per hit; name, phone and company carried", async () => {
    const [h] = await searchCustomers("6145550142");
    expect(h).toEqual({ id: "c-01", name: "Pat Example", phone: "614-555-0142", company: "Example Roofing", bookings: 5 });
  });

  it("too short: no query at all", async () => {
    expect(await searchCustomers("p")).toEqual([]);
    expect(await searchCustomers("61")).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("a database error throws a code with no term or data in it", async () => {
    failOn = (t) => (t === "customers" ? { code: "XX000", message: "boom near 'Pat Example' 614-555-0142" } : null);
    const err = await searchCustomers("Pat Example").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("customer search failed (name_XX000)");
    expect((err as unknown as { code: string }).code).toBe("name_XX000");
  });
});

describe("pickCustomer", () => {
  it("returns details, 3 distinct addresses (unsplittable greyed), consent on file and the latest record", async () => {
    const p = await pickCustomer("c-01");
    expect(p).toMatchObject({ id: "c-01", name: "Pat Example", email: "pat@crazylarrys.test", phone: "614-555-0142", company: "Example Roofing", bookings: 5 });
    expect(p!.addresses).toEqual([
      { label: "Lot 4 behind the barn", parts: null },
      { label: "9 Other Rd, Dublin, OH 43017", parts: { street: "9 Other Rd", city: "Dublin", state: "OH", zip: "43017" } },
      { label: "1 Test St, Columbus, OH 43004", parts: { street: "1 Test St", city: "Columbus", state: "OH", zip: "43004" } },
    ]);
    expect(p!.consent).toEqual({ onFile: true, last: { granted: true, source: "phone_verbal", recordedAt: "2026-11-03T15:00:00Z" } });
  });
  it("names its columns", async () => {
    await pickCustomer("c-01");
    expect(fake.calls.filter((c) => c.op === "select").map((c) => `${c.table}: ${c.args[0]}`)).toEqual([
      "customers: id, full_name, phone, email, company_name, sms_consent",
      "bookings: delivery_address, delivery_date",
      "bookings: id",
      "consent_records: granted, source, recorded_at",
    ]);
  });
  it("unknown id: null", async () => {
    expect(await pickCustomer("c-99")).toBeNull();
  });
});

describe("otherCustomerWithEmail", () => {
  it("another customer's email (any case): their name only", async () => {
    expect(await otherCustomerWithEmail("LEE@crazylarrys.test ", "c-01")).toBe("Lee Prepaid");
  });
  it("the picked customer's own email, or an unused one: null", async () => {
    expect(await otherCustomerWithEmail("pat@crazylarrys.test", "c-01")).toBeNull();
    expect(await otherCustomerWithEmail("new@crazylarrys.test", "c-01")).toBeNull();
  });
  it("exact match only: wildcards in the typed email are literal", async () => {
    expect(await otherCustomerWithEmail("l_e@crazylarrys.test", "c-01")).toBeNull();
    expect(await otherCustomerWithEmail("%@crazylarrys.test", "c-01")).toBeNull();
  });
  it("selects the name column only", async () => {
    await otherCustomerWithEmail("lee@crazylarrys.test", "c-01");
    expect(fake.calls.find((c) => c.op === "select")?.args[0]).toBe("full_name");
  });
});
