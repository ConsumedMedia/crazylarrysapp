/**
 * Unit test — the app's delivery-date floor (normalizeBookingInput), with the
 * clock faked, in both UTC (Vercel) and Asia/Tokyo. No database: the RPC
 * re-checks the floor with public.yard_today() (migration
 * 20261029000000_yard_today), which has its own rolled-back probe
 * (scripts/probe-yard-today.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { normalizeBookingInput, BookingCreateError } from "./create";
import type { CreateBookingInput } from "./types";

const base: CreateBookingInput = {
  size: "20yd",
  deliveryDate: "2026-10-30",
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Floor Test",
  contactEmail: "floor-test@example.com",
} as CreateBookingInput;

function floorCode(deliveryDate: string): string {
  try {
    normalizeBookingInput({ ...base, deliveryDate });
    return "ok";
  } catch (e) {
    return e instanceof BookingCreateError ? e.code : "threw";
  }
}

// [label, instant, refused (yard today), accepted (yard tomorrow)]
const CASES: Array<[string, string, string, string]> = [
  ["3:45 PM EDT Thu Oct 29", "2026-10-29T19:45:00Z", "2026-10-29", "2026-10-30"],
  ["9:00 PM EDT Thu Oct 29", "2026-10-30T01:00:00Z", "2026-10-29", "2026-10-30"],
  ["9:00 PM EDT Sat Oct 31", "2026-11-01T01:00:00Z", "2026-10-31", "2026-11-01"],
  ["9:00 PM EST Sun Nov 1 (after DST ends)", "2026-11-02T02:00:00Z", "2026-11-01", "2026-11-02"],
  ["11:30 PM EST Sun Nov 1", "2026-11-02T04:30:00Z", "2026-11-01", "2026-11-02"],
];

describe.each(["UTC", "Asia/Tokyo"])("delivery floor with the process in %s", (zone) => {
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs with the process actually in that zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
  });

  it.each(CASES)("%s: accepts the yard's tomorrow, refuses its today", (_label, at, today, tomorrow) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    expect(floorCode(tomorrow)).toBe("ok");
    expect(floorCode(today)).toBe("past_date");
  });
});
