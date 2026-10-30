/**
 * Unit test — payAndBook refuses a too-early delivery date BEFORE the card is
 * charged, with the clock faked, in both UTC (Vercel) and Asia/Tokyo.
 * QuickBooks, Supabase and createBooking are mocked; the mocked createBooking
 * applies the same floor normalizeBookingInput does, so without the step-0
 * check a too-early date is charged and then refunded.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { yardTomorrow } from "@/lib/time/yard";
import type { CreateBookingInput } from "./types";

const m = vi.hoisted(() => ({
  createCharge: vi.fn(),
  refundCharge: vi.fn(),
  createBooking: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/quickbooks/payments", () => ({
  createCharge: m.createCharge,
  refundCharge: m.refundCharge,
  PaymentError: class PaymentError extends Error {},
}));
vi.mock("./create", () => ({
  createBooking: m.createBooking,
  BookingCreateError: class BookingCreateError extends Error {
    code: string;
    constructor(message: string, code = "error") {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/notifications/notify", () => ({ notifyBookingConfirmation: vi.fn() }));

import { payAndBook } from "./checkout";
import { BookingCreateError } from "./create";

const base: CreateBookingInput = {
  size: "20yd",
  deliveryDate: "2026-10-30",
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Checkout Floor Test",
  contactEmail: "checkout-floor@example.com",
} as CreateBookingInput;
const payment = { token: "tok-test", idempotencyKey: "idem-test" };

// [label, instant, too early (yard today), first allowed (yard tomorrow)]
const CASES: Array<[string, string, string, string]> = [
  ["9:00 PM EDT Thu Oct 29 (UTC is already Oct 30)", "2026-10-30T01:00:00Z", "2026-10-29", "2026-10-30"],
  ["9:00 PM EDT Sat Oct 31", "2026-11-01T01:00:00Z", "2026-10-31", "2026-11-01"],
  ["1:30 AM EST Sun Nov 1 (repeated hour)", "2026-11-01T06:30:00Z", "2026-11-01", "2026-11-02"],
  ["9:00 PM EST Sun Nov 1 (after DST ends)", "2026-11-02T02:00:00Z", "2026-11-01", "2026-11-02"],
  ["11:30 PM EST Sun Nov 1 (a fixed -4h would say Nov 2)", "2026-11-02T04:30:00Z", "2026-11-01", "2026-11-02"],
];

describe.each(["UTC", "Asia/Tokyo"])("payAndBook date floor with the process in %s", (zone) => {
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  beforeEach(() => {
    vi.resetAllMocks();
    m.rpc.mockImplementation(async (fn: string) =>
      fn === "booking_quote" ? { data: [{ total: 450 }], error: null } : { data: null, error: null },
    );
    m.createCharge.mockResolvedValue({ chargeId: "ch-test" });
    m.refundCharge.mockResolvedValue({ refundId: "rf-test" });
    // Same floor as normalizeBookingInput, read at call time.
    m.createBooking.mockImplementation(async (input: CreateBookingInput) => {
      if (input.deliveryDate < yardTomorrow()) {
        throw new BookingCreateError("The earliest delivery is tomorrow.", "past_date");
      }
      return { bookingId: "bk-test" };
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs with the process actually in that zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
  });

  it.each(CASES)("%s: the yard's today is refused with no charge", async (_label, at, today) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    const res = await payAndBook({ ...base, deliveryDate: today }, payment);
    expect(res).toEqual({ ok: false, code: "past_date", error: "Delivery must be tomorrow or later." });
    expect(m.createCharge).not.toHaveBeenCalled();
    expect(m.refundCharge).not.toHaveBeenCalled();
    expect(m.createBooking).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each(CASES)("%s: the yard's tomorrow is charged and booked", async (_label, at, _today, tomorrow) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    const res = await payAndBook({ ...base, deliveryDate: tomorrow }, payment);
    expect(res).toEqual({ ok: true, bookingId: "bk-test" });
    expect(m.createCharge).toHaveBeenCalledTimes(1);
    expect(m.refundCharge).not.toHaveBeenCalled();
  });

  it("still refunds when the database refuses a date after charging", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T01:00:00Z")); // 9 PM EDT Oct 29
    m.createBooking.mockRejectedValueOnce(new BookingCreateError("That date is no longer available.", "unavailable"));
    const res = await payAndBook({ ...base, deliveryDate: "2026-10-30" }, payment);
    expect(m.createCharge).toHaveBeenCalledTimes(1);
    expect(m.refundCharge).toHaveBeenCalledWith({ chargeId: "ch-test", amount: "450.00" });
    expect(res).toMatchObject({ ok: false, code: "compensated", refunded: true });
    expect(m.rpc).toHaveBeenCalledWith(
      "record_payment_attempt",
      expect.objectContaining({ p_kind: "compensating_refund", p_qb_charge_id: "ch-test", p_qb_refund_id: "rf-test" }),
    );
  });
});
