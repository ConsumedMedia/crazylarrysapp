import { describe, it, expect } from "vitest";
import { deriveDay, isSelectable, LIMITED_MAX } from "./compute";
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
