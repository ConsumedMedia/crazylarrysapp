import { describe, it, expect, vi, afterEach } from "vitest";
import { isUnpaidDue, DRIVER_NOT_PAID } from "./unpaid-due";
import { yardToday } from "@/lib/time/yard";

afterEach(() => vi.useRealTimers());

const b = (over: Record<string, string | null> = {}) => ({
  payment_status: "unpaid",
  delivery_date: "2026-11-05",
  status: "confirmed",
  ...over,
});

describe("isUnpaidDue", () => {
  it("due on the delivery day itself and after", () => {
    expect(isUnpaidDue(b(), "2026-11-05")).toBe(true);
    expect(isUnpaidDue(b(), "2026-11-06")).toBe(true);
  });
  it("not due the day before", () => {
    expect(isUnpaidDue(b(), "2026-11-04")).toBe(false);
  });
  it("only unpaid warns", () => {
    for (const s of ["paid", "refunded", "failed"]) expect(isUnpaidDue(b({ payment_status: s }), "2026-11-09")).toBe(false);
  });
  it("cancelled and returned never warn; delivered/active/overdue still do", () => {
    expect(isUnpaidDue(b({ status: "cancelled" }), "2026-11-09")).toBe(false);
    expect(isUnpaidDue(b({ status: "returned" }), "2026-11-09")).toBe(false);
    for (const s of ["delivered", "active", "overdue", "scheduled_pickup"]) {
      expect(isUnpaidDue(b({ status: s }), "2026-11-09"), s).toBe(true);
    }
  });
  it("missing fields never warn", () => {
    expect(isUnpaidDue({ status: "confirmed" }, "2026-11-09")).toBe(false);
    expect(isUnpaidDue(b({ delivery_date: null }), "2026-11-09")).toBe(false);
  });
  it("driver wording", () => {
    expect(DRIVER_NOT_PAID.delivery).toBe("Not paid: call the office before delivering");
  });
});

describe("yard midnight (America/New_York), not UTC", () => {
  it("11:30 pm in New York on Nov 4 is already Nov 5 in UTC — a Nov 5 delivery is NOT due yet", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T04:30:00.000Z"));
    expect(yardToday()).toBe("2026-11-04");
    expect(isUnpaidDue(b(), yardToday())).toBe(false);
  });
  it("00:30 am in New York on Nov 5 — now it is due", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T05:30:00.000Z"));
    expect(yardToday()).toBe("2026-11-05");
    expect(isUnpaidDue(b(), yardToday())).toBe(true);
  });
});
