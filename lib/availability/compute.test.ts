import { describe, it, expect } from "vitest";
import { applyOnlineFloor, deriveDay, isSelectable, LIMITED_MAX } from "./compute";
import type { DeliveryFloor } from "@/lib/bookings/cutoff-shared";
import type { AvailabilityRow } from "./types";

const row = (over: Partial<AvailabilityRow>): AvailabilityRow => ({
  day: "2026-10-15",
  total: 6,
  committed: 0,
  blocked: false,
  is_past: false,
  ...over,
});

describe("deriveDay", () => {
  it("open when plenty free", () => {
    expect(deriveDay(row({ total: 6, committed: 1 })).state).toBe("open");
  });

  it("limited at exactly LIMITED_MAX and shows the real count", () => {
    const d = deriveDay(row({ total: 6, committed: 6 - LIMITED_MAX }));
    expect(d.state).toBe("limited");
    expect(d.available).toBe(LIMITED_MAX);
  });

  it("limited at 1 left", () => {
    expect(deriveDay(row({ total: 6, committed: 5 })).state).toBe("limited");
  });

  it("bookedout when committed meets or exceeds total", () => {
    expect(deriveDay(row({ total: 6, committed: 6 })).state).toBe("bookedout");
    expect(deriveDay(row({ total: 6, committed: 9 })).available).toBe(0);
  });

  it("past always wins, even with units free", () => {
    const d = deriveDay(row({ total: 6, committed: 0, is_past: true }));
    expect(d.state).toBe("past");
    expect(d.available).toBe(0);
  });

  it("closed (blocked) forces zero even with units free", () => {
    const d = deriveDay(row({ total: 6, committed: 0, blocked: true }));
    expect(d.state).toBe("closed");
    expect(d.available).toBe(0);
  });

  it("past takes precedence over blocked", () => {
    expect(
      deriveDay(row({ is_past: true, blocked: true })).state,
    ).toBe("past");
  });
});

describe("isSelectable", () => {
  it("open and limited are selectable; the rest are not", () => {
    expect(isSelectable(deriveDay(row({ committed: 0 })))).toBe(true);
    expect(isSelectable(deriveDay(row({ committed: 5 })))).toBe(true);
    expect(isSelectable(deriveDay(row({ committed: 6 })))).toBe(false);
    expect(isSelectable(deriveDay(row({ blocked: true })))).toBe(false);
    expect(isSelectable(deriveDay(row({ is_past: true })))).toBe(false);
  });
});

describe("applyOnlineFloor", () => {
  const floor: DeliveryFloor = {
    earliestOnline: "2026-10-17",
    earliestStaff: "2026-10-16",
    cutoffEnabled: true,
    cutoffTime: "15:00",
    afterCutoff: true,
    nextChangeAt: "2026-10-16T04:00:00.000Z",
    source: "database",
  };
  const day = (date: string) => deriveDay(row({ day: date, committed: 1 }));

  it("a day the cutoff closed shows as past and isn't selectable", () => {
    const d = applyOnlineFloor(day("2026-10-16"), floor);
    expect(d).toMatchObject({ state: "past", available: 0, total: 6, committed: 1 });
    expect(isSelectable(d)).toBe(false);
  });

  it("days on or after the online floor, and already-past days, are untouched", () => {
    expect(applyOnlineFloor(day("2026-10-17"), floor)).toEqual(day("2026-10-17"));
    const past = deriveDay(row({ day: "2026-10-15", is_past: true }));
    expect(applyOnlineFloor(past, floor)).toBe(past);
  });

  it("with the cutoff off (online floor = staff floor) nothing changes", () => {
    const off = { ...floor, earliestOnline: "2026-10-16", cutoffEnabled: false, afterCutoff: false };
    expect(applyOnlineFloor(day("2026-10-16"), off)).toEqual(day("2026-10-16"));
  });
});
