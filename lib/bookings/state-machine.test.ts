import { describe, it, expect } from "vitest";
import {
  bookingTransitionAllowed,
  nextBookingStatuses,
  BOOKING_STATUSES,
} from "./state-machine";

describe("booking lifecycle (UI mirror)", () => {
  it("matches the intended matrix", () => {
    const matrix = Object.fromEntries(
      BOOKING_STATUSES.map((s) => [s, nextBookingStatuses(s)]),
    );
    expect(matrix).toEqual({
      confirmed: ["delivered", "cancelled"],
      delivered: ["active", "cancelled"],
      active: ["pickup_scheduled", "overdue", "cancelled"],
      pickup_scheduled: ["returned", "overdue", "cancelled"],
      overdue: ["pickup_scheduled", "returned", "cancelled"],
      returned: [],
      cancelled: [],
    });
  });

  it("never allows a no-op", () => {
    for (const s of BOOKING_STATUSES) {
      expect(bookingTransitionAllowed(s, s)).toBe(false);
    }
  });

  it("cancellable from every non-terminal state", () => {
    for (const s of BOOKING_STATUSES) {
      const expected = s !== "returned" && s !== "cancelled";
      expect(bookingTransitionAllowed(s, "cancelled")).toBe(expected);
    }
  });

  it("blocks skipping confirmed straight to active/returned", () => {
    expect(bookingTransitionAllowed("confirmed", "active")).toBe(false);
    expect(bookingTransitionAllowed("confirmed", "returned")).toBe(false);
  });

  it("returned and cancelled are terminal (except no re-cancel)", () => {
    expect(nextBookingStatuses("returned")).toEqual([]);
    expect(nextBookingStatuses("cancelled")).toEqual([]);
  });
});
