/**
 * Unit test — payAndBook refuses every input it can judge without the
 * database BEFORE the card is charged, and after a charge it tells the
 * customer why the database refused (only a capacity refusal says "filled
 * up"), refunding in every case. Clock faked at 9 PM EDT Oct 29 and 11:30 PM
 * EST Nov 1, with the process in UTC (Vercel) and Asia/Tokyo.
 *
 * QuickBooks, Supabase and createBooking are mocked; normalizeBookingInput and
 * bookingRpcError are real. The live database wording is pinned separately by
 * create-booking-wording.integration.test.ts (opt-in, rolled back).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { yardToday, yardTomorrow } from "@/lib/time/yard";
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
vi.mock("./create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./create")>()),
  createBooking: m.createBooking,
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/notifications/notify", () => ({ notifyBookingConfirmation: vi.fn() }));

import { payAndBook } from "./checkout";
import { BookingCreateError, bookingRpcError } from "./create";

const base = {
  size: "20yd",
  rentalDays: 5,
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Checkout Validation Test",
  contactEmail: "checkout-validation@example.com",
} as Omit<CreateBookingInput, "deliveryDate">;
const payment = { token: "tok-test", idempotencyKey: "idem-test" };

const CLOCKS: Array<[string, string]> = [
  ["9:00 PM EDT Thu Oct 29 (UTC is already Oct 30)", "2026-10-30T01:00:00Z"],
  ["11:30 PM EST Sun Nov 1 (UTC is already Nov 2)", "2026-11-02T04:30:00Z"],
];

// [label, change to a valid input, code, customer-facing message]. "TODAY"
// stands for the yard's today at the faked clock.
const EARLY: Array<[string, Partial<CreateBookingInput>, string, string]> = [
  ["unknown size", { size: "40yd" as CreateBookingInput["size"] }, "bad_size", "Pick a dumpster size."],
  ["empty date", { deliveryDate: "" }, "bad_date", "Pick a delivery date."],
  ["US-style date", { deliveryDate: "10/30/2026" }, "bad_date", "Pick a delivery date."],
  ["unpadded date", { deliveryDate: "2026-1-5" }, "bad_date", "Pick a delivery date."],
  ["the yard's today", { deliveryDate: "TODAY" }, "past_date", "Delivery must be tomorrow or later."],
  ["0 rental days", { rentalDays: 0 }, "bad_rental", "Invalid rental length."],
  ["61 rental days", { rentalDays: 61 }, "bad_rental", "Invalid rental length."],
  ["2.5 rental days", { rentalDays: 2.5 }, "bad_rental", "Invalid rental length."],
  ["no street", { street: "" }, "bad_address", "A full delivery address is required."],
  ["blank city", { city: "   " }, "bad_address", "A full delivery address is required."],
  ["no state", { state: "" }, "bad_address", "A full delivery address is required."],
  ["no zip", { zip: "" }, "bad_address", "A full delivery address is required."],
  ["blank contact name", { contactName: "  " }, "bad_contact", "A contact name is required."],
  ["no email or phone", { contactEmail: "", contactPhone: "" }, "no_contact", "Add an email or a phone number so we can reach you."],
  ["malformed email", { contactEmail: "bob@" }, "bad_email", "That email doesn't look right."],
];

const NOT_CHARGED = "you have not been charged (the card authorization has been reversed).";
const PENDING = "A refund is being processed — contact the yard if you don't see it within a few days.";

// [reason the database gave, refund succeeded, exact message]
const COMPENSATED: Array<[string, boolean, string]> = [
  ["unavailable", true, `That date filled up while you were checking out, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`],
  ["unavailable", false, `That date filled up while you were checking out and the booking didn't go through. ${PENDING}`],
  ["past_date", true, `Delivery must be tomorrow or later, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`],
  ["past_date", false, `Delivery must be tomorrow or later, so the booking didn't go through. ${PENDING}`],
  ["blocked", true, `That date is no longer available, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`],
  ["blocked", false, `That date is no longer available, so the booking didn't go through. ${PENDING}`],
  ["unavailable_unrecognized", true, `Something went wrong and the booking didn't go through — ${NOT_CHARGED} Please try again or call the yard.`],
  ["unavailable_unrecognized", false, `Something went wrong and the booking didn't go through. ${PENDING}`],
  ["pricing_not_configured", true, `Something went wrong and the booking didn't go through — ${NOT_CHARGED} Please try again or call the yard.`],
  ["pricing_not_configured", false, `Something went wrong and the booking didn't go through. ${PENDING}`],
  ["P0001", true, `Something went wrong and the booking didn't go through — ${NOT_CHARGED} Please try again or call the yard.`],
  ["P0001", false, `Something went wrong and the booking didn't go through. ${PENDING}`],
  // Not a BookingCreateError at all (network, bug): reason "error".
  ["error", true, `Something went wrong and the booking didn't go through — ${NOT_CHARGED} Please try again or call the yard.`],
  ["error", false, `Something went wrong and the booking didn't go through. ${PENDING}`],
];

describe.each(["UTC", "Asia/Tokyo"])("payAndBook with the process in %s", (zone) => {
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
    m.createBooking.mockResolvedValue({ bookingId: "bk-test" });
    // The refund-failed cases log on purpose; keep the run readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs with the process actually in that zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
  });

  describe.each(CLOCKS)("at %s", (_clock, at) => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(at));
    });

    it.each(EARLY)("%s: refused before any charge", async (_label, change, code, message) => {
      const input = { ...base, deliveryDate: yardTomorrow(), ...change } as CreateBookingInput;
      if (input.deliveryDate === "TODAY") input.deliveryDate = yardToday();
      const res = await payAndBook(input, payment);
      expect(res).toEqual({ ok: false, code, error: message });
      expect(m.createCharge).not.toHaveBeenCalled();
      expect(m.refundCharge).not.toHaveBeenCalled();
      expect(m.createBooking).not.toHaveBeenCalled();
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("a valid booking for the yard's tomorrow uses the normalized input throughout", async () => {
      const tomorrow = yardTomorrow();
      const res = await payAndBook(
        { ...base, deliveryDate: tomorrow, street: "  1 Test St ", contactPhone: "  " } as CreateBookingInput,
        payment,
      );
      expect(res).toEqual({ ok: true, bookingId: "bk-test" });
      expect(m.rpc).toHaveBeenCalledWith("booking_quote", { p_size: "20yd" });
      expect(m.createCharge).toHaveBeenCalledTimes(1);
      expect(m.createCharge).toHaveBeenCalledWith(
        expect.objectContaining({ amount: "450.00", description: "Crazy Larry's — 20 yd dumpster" }),
      );
      expect(m.createBooking).toHaveBeenCalledWith(
        expect.objectContaining({
          p_size: "20yd",
          p_delivery_date: tomorrow,
          p_delivery_address: "1 Test St, Columbus, OH 43215",
          p_contact_phone: null,
          p_rental_days: 5,
        }),
      );
      expect(m.refundCharge).not.toHaveBeenCalled();
    });

    it.each(COMPENSATED)(
      "database refuses after the charge (%s, refund succeeded: %s): refund, record, message",
      async (reason, refundOk, message) => {
        m.createBooking.mockRejectedValueOnce(
          reason === "error" ? new Error("socket hang up") : new BookingCreateError(`db said ${reason}`, reason),
        );
        if (!refundOk) m.refundCharge.mockRejectedValueOnce(new Error("refund timed out"));
        const tomorrow = yardTomorrow();
        const res = await payAndBook({ ...base, deliveryDate: tomorrow } as CreateBookingInput, payment);

        expect(m.createCharge).toHaveBeenCalledTimes(1);
        expect(m.refundCharge).toHaveBeenCalledWith({ chargeId: "ch-test", amount: "450.00" });
        expect(res).toEqual({ ok: false, code: "compensated", reason, refunded: refundOk, error: message });
        expect(res.error!.includes("filled up")).toBe(reason === "unavailable");
        expect(m.rpc).toHaveBeenCalledWith("record_payment_attempt", {
          p_kind: "compensating_refund",
          p_qb_charge_id: "ch-test",
          p_qb_refund_id: refundOk ? "rf-test" : null,
          p_amount: 450,
          p_contact_email: "checkout-validation@example.com",
          p_reason: reason === "error" ? "booking creation failed" : `db said ${reason}`,
          p_context: {
            booking_error_code: reason,
            refund_succeeded: refundOk,
            size: "20yd",
            delivery_date: tomorrow,
          },
        });
      },
    );
  });
});

// The database's wording as of 2026-11-02 (_create_booking_core), all with
// hint 'unavailable'. create-booking-wording.integration.test.ts checks these
// against the live function.
describe("bookingRpcError splits the database's date refusals", () => {
  const ROWS: Array<[string, string, string]> = [
    ["Delivery date must be tomorrow or later", "past_date", "Delivery must be tomorrow or later."],
    ["Delivery on 2026-11-05 is blocked for 20yd", "blocked", "That date is blocked for this size. Pick another day."],
    ["No 20yd units available for delivery on 2026-11-05", "unavailable", "That date just filled up for this size. Pick another day."],
  ];
  it.each(ROWS)("%s -> %s", (dbMessage, code, message) => {
    const e = bookingRpcError({ message: dbMessage, code: "P0001", hint: "unavailable" });
    expect([e.code, e.message]).toEqual([code, message]);
  });

  it("an unrecognized message with the same hint is never 'filled up'", () => {
    const e = bookingRpcError({ message: "Something new happened", code: "P0001", hint: "unavailable" });
    expect(e.code).toBe("unavailable_unrecognized");
    expect(e.message).not.toMatch(/filled up/);
  });
});
