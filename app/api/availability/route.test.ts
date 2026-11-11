/**
 * Unit test for GET /api/availability: the response carries the delivery
 * floor next to the days, and a floor fallback never breaks the calendar.
 * The queries and the floor helper are fakes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { DeliveryFloor } from "@/lib/bookings/cutoff-shared";

const days = [{ date: "2026-11-12", total: 6, committed: 0, available: 6, state: "open" }];
let floor: DeliveryFloor;
let rangeFails = false;
vi.mock("@/lib/availability/queries", () => ({
  getRangeAvailability: async (size: string, _from: string, _to: string, rentalDays: number) => {
    if (rangeFails) throw new Error("size_availability RPC: boom");
    return { size, rentalDays, days };
  },
}));
vi.mock("@/lib/bookings/cutoff", () => ({ getDeliveryFloor: async () => floor }));

const AFTER: DeliveryFloor = {
  earliestOnline: "2026-11-13",
  earliestStaff: "2026-11-12",
  cutoffEnabled: true,
  cutoffTime: "15:00",
  afterCutoff: true,
  nextChangeAt: "2026-11-12T05:00:00.000Z",
  source: "database",
};

async function get(qs: string) {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/availability?${qs}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  floor = AFTER;
  rangeFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/api/availability", () => {
  it("returns the days unchanged plus the floor", async () => {
    const r = await get("size=15yd&from=2026-11-01&to=2026-12-12&rentalDays=5");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ size: "15yd", rentalDays: 5, days, floor: AFTER });
  });

  it("a fallback floor (database answer unavailable) is passed through as today's rule", async () => {
    floor = { ...AFTER, earliestOnline: "2026-11-12", cutoffEnabled: false, afterCutoff: false, source: "fallback" };
    const r = await get("size=15yd&from=2026-11-01&to=2026-12-12");
    expect(r.status).toBe(200);
    expect(r.body.floor.source).toBe("fallback");
    expect(r.body.days).toEqual(days);
  });

  it("bad input is still refused before anything is read", async () => {
    expect((await get("size=99yd&from=2026-11-01&to=2026-11-02")).status).toBe(400);
  });

  it("a failing day lookup is still a 500 (the floor doesn't hide it)", async () => {
    rangeFails = true;
    expect((await get("size=15yd&from=2026-11-01&to=2026-11-02")).status).toBe(500);
  });
});
