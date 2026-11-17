/**
 * Unit test — the DocuSign agreement gate in online checkout, on the
 * validate-before-charge structure (docusign-port, task 3). payAndBook must
 * refuse before the quote or the card is touched unless an email is given and
 * the agreement session passes checkAgreementForCheckout; it passes the
 * session to createBooking; and an agreement refusal from create_booking
 * after the charge is refunded with the agreement wording. QuickBooks,
 * Supabase, createBooking and the gate are fakes; normalizeBookingInput,
 * bookingRpcError and compensationMessage are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CreateBookingInput } from "./types";

const m = vi.hoisted(() => ({
  createCharge: vi.fn(),
  refundCharge: vi.fn(),
  createBooking: vi.fn(),
  rpc: vi.fn(),
  gate: vi.fn(),
  calls: [] as string[],
}));
vi.mock("@/lib/quickbooks/payments", () => ({
  createCharge: (...a: unknown[]) => (m.calls.push("charge"), m.createCharge(...a)),
  refundCharge: (...a: unknown[]) => (m.calls.push("refund"), m.refundCharge(...a)),
  PaymentError: class PaymentError extends Error {},
}));
vi.mock("./create", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./create")>()),
  createBooking: (...a: unknown[]) => (m.calls.push("createBooking"), m.createBooking(...a)),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc: (fn: string, args: unknown) => (m.calls.push(`rpc:${fn}`), m.rpc(fn, args)) }),
}));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/notifications/notify", () => ({ notifyBookingConfirmation: vi.fn() }));
vi.mock("@/lib/docusign/agreement", () => ({
  checkAgreementForCheckout: (...a: unknown[]) => (m.calls.push("gate"), m.gate(...a)),
}));

import { payAndBook, compensationMessage } from "./checkout";
import { bookingRpcError } from "./create";
import { yardTomorrow } from "@/lib/time/yard";

const payment = { token: "tok-test", idempotencyKey: "idem-test" };
const base = () =>
  ({
    size: "20yd",
    deliveryDate: yardTomorrow(),
    street: "1 Test St",
    city: "Columbus",
    state: "OH",
    zip: "43215",
    contactName: "Agreement Gate Test",
    contactEmail: "Gate.Test@crazylarrys.test",
  }) as CreateBookingInput;

beforeEach(() => {
  vi.resetAllMocks();
  m.calls.length = 0;
  m.rpc.mockImplementation(async (fn: string) =>
    fn === "booking_quote"
      ? { data: [{ total: 450 }], error: null }
      : fn === "booking_delivery_floor"
        ? { data: null, error: { message: "unreadable on purpose: fall back to tomorrow" } }
        : { data: null, error: null },
  );
  m.createCharge.mockResolvedValue({ chargeId: "ch-test" });
  m.refundCharge.mockResolvedValue({ refundId: "rf-test", kind: "void", status: "ISSUED", rawType: "VOID" });
  m.createBooking.mockResolvedValue({ bookingId: "bk-test" });
  m.gate.mockResolvedValue({ ok: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("agreement gate: refused before the quote or the card", () => {
  it.each([
    ["agreement_missing", "Please sign the rental agreement first."],
    ["agreement_incomplete", "Your rental agreement isn't signed yet."],
    ["agreement_used", "That agreement was already used for a booking. Please sign a new one."],
    ["agreement_expired", "Your agreement session expired. Please sign again."],
    ["agreement_email_mismatch", "The agreement was signed with a different email than this booking. Please sign again with this email."],
  ])("%s", async (code, error) => {
    m.gate.mockResolvedValue({ ok: false, code, error });
    const r = await payAndBook(base(), payment, "agr-1");
    expect(r).toEqual({ ok: false, code, error });
    expect(m.calls).not.toContain("rpc:booking_quote");
    expect(m.calls).not.toContain("charge");
    expect(m.calls).not.toContain("createBooking");
  });

  it("the gate gets the session and the NORMALIZED email, after validation and the cutoff", async () => {
    await payAndBook({ ...base(), contactEmail: "  Gate.Test@crazylarrys.test " }, payment, "agr-1");
    expect(m.gate).toHaveBeenCalledWith("agr-1", "Gate.Test@crazylarrys.test");
    expect(m.calls.slice(0, 4)).toEqual(["rpc:booking_delivery_floor", "gate", "rpc:booking_quote", "charge"]);
  });

  it("no email: refused as no_email before the cutoff read or the gate (phone-only books by phone)", async () => {
    const r = await payAndBook({ ...base(), contactEmail: "", contactPhone: "614-321-7654" }, payment, "agr-1");
    expect(r).toMatchObject({ ok: false, code: "no_email" });
    expect(m.calls).toEqual([]);
  });

  it("bad input is still refused by validation first, with its own code", async () => {
    const r = await payAndBook({ ...base(), size: "99yd" } as unknown as CreateBookingInput, payment, "agr-1");
    expect(r).toMatchObject({ ok: false, code: "bad_size" });
    expect(m.calls).toEqual([]);
  });

  it("no session at all: whatever the gate says (agreement_missing), never a charge", async () => {
    m.gate.mockResolvedValue({ ok: false, code: "agreement_missing", error: "Please sign the rental agreement first." });
    const r = await payAndBook(base(), payment, undefined);
    expect(m.gate).toHaveBeenCalledWith(undefined, "Gate.Test@crazylarrys.test");
    expect(r.code).toBe("agreement_missing");
    expect(m.calls).not.toContain("charge");
  });
});

describe("agreement passed", () => {
  it("createBooking gets the normalized params and the session", async () => {
    const r = await payAndBook(base(), payment, "agr-1");
    expect(r).toEqual({ ok: true, bookingId: "bk-test" });
    expect(m.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ p_contact_email: "Gate.Test@crazylarrys.test", p_size: "20yd" }),
      { agreementSessionId: "agr-1" },
    );
  });

  it("create_booking's own agreement re-check after the charge: refunded, reason kept, agreement wording", async () => {
    m.createBooking.mockRejectedValue(
      bookingRpcError({ message: "Rental agreement was already used for another booking", code: "P0001", hint: "agreement_used" }),
    );
    const r = await payAndBook(base(), payment, "agr-1");
    expect(m.calls).toContain("refund");
    expect(r).toEqual({
      ok: false,
      code: "compensated",
      reason: "agreement_used",
      refunded: true,
      error: compensationMessage("agreement_used", true),
    });
    expect(r.error).toContain("Please sign the agreement again.");
    expect(r.error).not.toContain("filled up");
  });
});

describe("compensationMessage for agreement reasons", () => {
  it.each(["agreement_used", "agreement_expired", "agreement_email_mismatch", "agreement_incomplete", "agreement_missing"])("%s", (reason) => {
    expect(compensationMessage(reason, true)).toMatch(/^Your rental agreement could not be used.*Please sign the agreement again\.$/);
    expect(compensationMessage(reason, false)).toMatch(/A refund is being processed/);
  });
});

describe("bookingRpcError maps the database's agreement hints", () => {
  it.each(["agreement_missing", "agreement_incomplete", "agreement_used", "agreement_expired", "agreement_email_mismatch"])("%s", (hint) => {
    const e = bookingRpcError({ message: "x", code: "P0001", hint });
    expect(e.code).toBe(hint);
  });
});
