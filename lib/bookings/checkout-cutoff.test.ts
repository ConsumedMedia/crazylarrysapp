/**
 * Unit test — the order cutoff in online checkout. payAndBook asks the
 * database for the floor (booking_delivery_floor, faked here) in step 0 and
 * refuses a day the cutoff closed BEFORE the quote or the card is touched.
 * QuickBooks, Supabase and createBooking are fakes; normalizeBookingInput and
 * bookingRpcError are real. The clock is pinned to Wed Nov 11, 2026, 4:00 PM
 * Eastern: tomorrow is Nov 12.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import { payAndBook, compensationMessage } from "./checkout";
import { bookingRpcError } from "./create";
import { refusalStep } from "@/app/(customer)/book/_components/refusal-step";

const AFTER_ROW = {
  earliest_online: "2026-11-13",
  earliest_staff: "2026-11-12",
  cutoff_enabled: true,
  cutoff_time: "15:00:00",
  after_cutoff: true,
  next_change_at: "2026-11-12T05:00:00+00:00",
};
const base = {
  size: "20yd",
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Checkout Cutoff Test",
  contactEmail: "checkout-cutoff@example.com",
} as Omit<CreateBookingInput, "deliveryDate">;
const payment = { token: "tok-test", idempotencyKey: "idem-test" };
const book = (deliveryDate: string) => payAndBook({ ...base, deliveryDate } as CreateBookingInput, payment);

let floorReply: () => Promise<{ data: unknown; error: unknown }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T21:00:00.000Z"));
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  floorReply = async () => ({ data: [AFTER_ROW], error: null });
  m.rpc.mockImplementation(async (fn: string) => {
    if (fn === "booking_delivery_floor") return floorReply();
    if (fn === "booking_quote") return { data: [{ total: 450 }], error: null };
    return { data: null, error: null };
  });
  m.createCharge.mockResolvedValue({ chargeId: "ch-test" });
  m.refundCharge.mockResolvedValue({ refundId: "rf-test", kind: "void" });
  m.createBooking.mockResolvedValue({ bookingId: "bk-test" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rpcNames = () => m.rpc.mock.calls.map((c) => c[0]);

describe("payAndBook and the order cutoff", () => {
  it("after the cutoff, tomorrow: refused in step 0 — no quote, no charge, no booking", async () => {
    const r = await book("2026-11-12");
    expect(r).toEqual({
      ok: false,
      code: "after_cutoff",
      error: "It's past 3:00 PM Eastern, so tomorrow is no longer available. The earliest delivery is Friday, Nov 13. You have not been charged.",
    });
    expect(m.createCharge).not.toHaveBeenCalled();
    expect(m.createBooking).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual(["booking_delivery_floor"]);
  });

  it("after the cutoff, the day after tomorrow: charged and booked as usual", async () => {
    const r = await book("2026-11-13");
    expect(r).toEqual({ ok: true, bookingId: "bk-test" });
    expect(m.createCharge).toHaveBeenCalledTimes(1);
    expect(rpcNames().slice(0, 2)).toEqual(["booking_delivery_floor", "booking_quote"]);
  });

  it("the floor can't be read (error or throw): today's rule — tomorrow goes through", async () => {
    floorReply = async () => ({ data: null, error: { code: "57014" } });
    expect(await book("2026-11-12")).toEqual({ ok: true, bookingId: "bk-test" });
    floorReply = () => Promise.reject(new Error("fetch failed"));
    expect(await book("2026-11-12")).toEqual({ ok: true, bookingId: "bk-test" });
  });

  it("the cutoff off: tomorrow goes through", async () => {
    floorReply = async () => ({ data: [{ ...AFTER_ROW, earliest_online: "2026-11-12", cutoff_enabled: false, after_cutoff: false }], error: null });
    expect(await book("2026-11-12")).toEqual({ ok: true, bookingId: "bk-test" });
  });

  it("other step-0 refusals still come first and never read the floor", async () => {
    const r = await payAndBook({ ...base, deliveryDate: "2026-11-12", contactEmail: "nope" } as CreateBookingInput, payment);
    expect(r.code).toBe("bad_email");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("if the database still refuses after the charge (floor unreadable at step 0): refunded, reason after_cutoff, Dates step", async () => {
    floorReply = async () => ({ data: null, error: { code: "57014" } });
    m.createBooking.mockRejectedValue(bookingRpcError({ message: "Delivery date is closed by the 15:00 order cutoff; earliest delivery is 2026-11-13", hint: "after_cutoff", code: "P0001" }));
    const r = await book("2026-11-12");
    expect(r).toMatchObject({ ok: false, code: "compensated", reason: "after_cutoff", refunded: true });
    expect(r.error).toBe(compensationMessage("after_cutoff", true));
    expect(r.error).toContain("you have not been charged");
    expect(m.refundCharge).toHaveBeenCalledTimes(1);
    expect(refusalStep(r.code, r.reason)).toEqual({ step: 2, clearDate: true });
  });
});

describe("after_cutoff mapping", () => {
  it("bookingRpcError maps the database's hint, whatever the message says", () => {
    const e = bookingRpcError({ message: "anything", hint: "after_cutoff", code: "P0001" });
    expect([e.code, e.message]).toEqual(["after_cutoff", "Orders placed after the cutoff can't be delivered tomorrow. Pick a later day."]);
  });

  it("refusalStep sends an early after_cutoff refusal to the Dates step and clears the day", () => {
    expect(refusalStep("after_cutoff")).toEqual({ step: 2, clearDate: true });
  });

  it("the compensation wording, refunded and not", () => {
    expect(compensationMessage("after_cutoff", true)).toBe(
      "Orders placed after the cutoff can't be delivered tomorrow, so the booking didn't go through — you have not been charged (the card authorization has been reversed). Please pick another day.",
    );
    expect(compensationMessage("after_cutoff", false)).toBe(
      "Orders placed after the cutoff can't be delivered tomorrow, so the booking didn't go through. A refund is being processed — contact the yard if you don't see it within a few days.",
    );
  });
});
