import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  consentOnFileText,
  createSearchController,
  editWarnings,
  fillAddress,
  fillFromPick,
  type SearchState,
} from "./autofill";
import type { CustomerHit, PickedCustomer } from "./search-shared";

const PICKED: PickedCustomer = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Pat Example",
  email: "pat@crazylarrys.test",
  phone: "614-555-0142",
  company: "Example Roofing",
  bookings: 3,
  addresses: [
    { label: "1 Test St, Columbus, OH 43004", parts: { street: "1 Test St", city: "Columbus", state: "OH", zip: "43004" } },
    { label: "Lot 4 behind the barn", parts: null },
  ],
  consent: { onFile: true, last: { granted: true, source: "phone_verbal", recordedAt: "2026-11-03T15:00:00Z" } },
};
const same = { name: "Pat Example", phone: "614-555-0142", email: "pat@crazylarrys.test", company: "Example Roofing" };

describe("fillFromPick", () => {
  it("fills name, phone, email and company only — no address, texts unticked even when agreed on file", () => {
    const f = fillFromPick(PICKED);
    expect(f).toEqual({ ...same, smsConsent: false });
    expect(Object.keys(f).some((k) => /street|city|state|zip|address/i.test(k))).toBe(false);
  });
  it("missing values become empty fields", () => {
    expect(fillFromPick({ ...PICKED, email: null, phone: null, company: null })).toMatchObject({ email: "", phone: "", company: "" });
  });
});

describe("fillAddress", () => {
  it("a splittable address fills all four parts; a greyed one fills nothing", () => {
    expect(fillAddress(PICKED.addresses[0])).toEqual({ street: "1 Test St", city: "Columbus", state: "OH", zip: "43004" });
    expect(fillAddress(PICKED.addresses[1])).toBeNull();
  });
});

describe("consentOnFileText", () => {
  it("agreed, with how and when (yard date)", () => {
    expect(consentOnFileText(PICKED.consent)).toBe("On file: agreed to texts (by phone, Nov 3)");
    expect(consentOnFileText({ onFile: true, last: { granted: true, source: "pay_page", recordedAt: "2026-11-05T03:00:00Z" } })).toBe(
      "On file: agreed to texts (on the pay page, Nov 4)",
    );
  });
  it("agreed with no record, and no texts", () => {
    expect(consentOnFileText({ onFile: true, last: null })).toBe("On file: agreed to texts");
    expect(consentOnFileText({ onFile: false, last: PICKED.consent.last })).toBe("On file: no texts");
  });
});

describe("editWarnings", () => {
  it("nothing changed (email case aside): no warnings", () => {
    expect(editWarnings(PICKED, { ...same, email: "PAT@crazylarrys.test " }, null)).toEqual([]);
  });
  it("each change is spelled out; phones by last 4 digits only", () => {
    const w = editWarnings(PICKED, { name: "Pat X", phone: "(614) 555-0199", email: "pat2@crazylarrys.test", company: "New Co" }, null);
    expect(w).toEqual([
      "Booking will update this customer's name on file.",
      "Booking will update this customer's phone on file (…0142 → …0199).",
      "Booking will update this customer's email on file.",
      "Booking will update this customer's company on file.",
    ]);
    expect(w.join(" ")).not.toContain("614");
  });
  it("same number in another format is not a change", () => {
    expect(editWarnings(PICKED, { ...same, phone: "6145550142" }, null)).toEqual([]);
  });
  it("phone cleared: the one on file stays (the database keeps it)", () => {
    expect(editWarnings(PICKED, { ...same, phone: "" }, null)).toEqual(["Phone left blank: the phone on file (…0142) stays."]);
  });
  it("email that belongs to another customer: warns with that customer's name only", () => {
    const w = editWarnings(PICKED, { ...same, email: "lee@crazylarrys.test" }, "Lee Prepaid");
    expect(w).toContain("That email already belongs to another customer: Lee Prepaid.");
  });
  it("the other-customer warning only appears when the email actually changed", () => {
    expect(editWarnings(PICKED, same, "Lee Prepaid")).toEqual([]);
  });
});

describe("createSearchController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const hit = (id: string): CustomerHit => ({ id, name: id, phone: null, company: null, bookings: 0 });

  it("debounces: rapid typing runs one search, 250 ms after the last key", async () => {
    const run = vi.fn(async () => ({ ok: true as const, hits: [hit("a")] }));
    const states: SearchState<CustomerHit>[] = [];
    const s = createSearchController<CustomerHit>({ run, onState: (x) => states.push(x) });
    s.type("pa");
    vi.advanceTimersByTime(100);
    s.type("pat");
    vi.advanceTimersByTime(249);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("pat");
    expect(states.at(-1)).toEqual({ status: "results", hits: [hit("a")] });
  });

  it("a slow older reply never replaces a newer one", async () => {
    let release: (v: { ok: true; hits: CustomerHit[] }) => void = () => {};
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockImplementationOnce(async () => ({ ok: true, hits: [hit("new")] }));
    const states: SearchState<CustomerHit>[] = [];
    const s = createSearchController<CustomerHit>({ run, onState: (x) => states.push(x) });
    s.type("old");
    await vi.advanceTimersByTimeAsync(250);
    s.type("newer");
    await vi.advanceTimersByTimeAsync(250);
    release({ ok: true, hits: [hit("old")] });
    await vi.runAllTimersAsync();
    expect(states.at(-1)).toEqual({ status: "results", hits: [hit("new")] });
    expect(states.some((x) => x.status === "results" && x.hits[0].id === "old")).toBe(false);
  });

  it("nothing found -> empty; failure or thrown -> error; too short -> idle with no search", async () => {
    const states: SearchState<CustomerHit>[] = [];
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, hits: [] })
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("offline"));
    const s = createSearchController<CustomerHit>({ run, onState: (x) => states.push(x) });
    for (const t of ["zzq", "pat", "lee"]) {
      s.type(t);
      await vi.advanceTimersByTimeAsync(250);
      await vi.runAllTimersAsync();
    }
    expect(states.filter((x) => x.status !== "loading").map((x) => x.status)).toEqual(["empty", "error", "error"]);
    s.type("p");
    expect(states.at(-1)).toEqual({ status: "idle" });
    expect(run).toHaveBeenCalledTimes(3);
  });
});
