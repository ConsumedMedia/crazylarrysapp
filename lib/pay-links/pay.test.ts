/**
 * Unit test for the /pay sequence — no network, no database, no card. The
 * service client, Intuit charge/refund, the invoice sync and the confirmation
 * are all fakes; each case scripts the RPC answers and asserts what was
 * charged, refunded, recorded and told to the customer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const LINK = "11111111-1111-1111-1111-111111111111";
const BOOKING = "22222222-2222-2222-2222-222222222222";
const REQ = "33333333-3333-3333-3333-333333333333";

type Rpc = (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null };
let rpcs: Record<string, Rpc>;
const calls: Array<[string, Record<string, unknown>]> = [];
let readBack: { status: string; qb_charge_id: string } | null;

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push([name, args]);
      const h = rpcs[name];
      return h ? h(args) : { data: null, error: null };
    },
    from: () => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: readBack, error: null }) };
      return chain;
    },
  }),
}));

const createCharge = vi.fn();
const refundCharge = vi.fn();
vi.mock("@/lib/quickbooks/payments", () => {
  class PaymentError extends Error {
    code: string;
    declined: boolean;
    constructor(message: string, code = "payment_error", declined = false) {
      super(message);
      this.code = code;
      this.declined = declined;
    }
  }
  return { createCharge: (...a: unknown[]) => createCharge(...a), refundCharge: (...a: unknown[]) => refundCharge(...a), PaymentError };
});
const syncInvoiceForBooking = vi.fn(async (id: string) => (void id, "qbo-1"));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: (id: string) => syncInvoiceForBooking(id) }));
const notifyBookingConfirmation = vi.fn(async (id: string) => void id);
vi.mock("@/lib/notifications/notify", () => ({ notifyBookingConfirmation: (id: string) => notifyBookingConfirmation(id) }));

const ACTIVE = {
  state: "active", link_id: LINK, booking_id: BOOKING, first_name: "Pat", size: "15yd",
  delivery_date: "2026-11-10", pickup_date: "2026-11-15", delivery_address: "1 Test St",
  subtotal: 324, tax: 24.3, total: 348.3,
};
const ok = (data: unknown) => () => ({ data, error: null });

beforeEach(() => {
  calls.length = 0;
  readBack = null;
  createCharge.mockReset().mockResolvedValue({ chargeId: "ch-1" });
  refundCharge.mockReset().mockResolvedValue({ refundId: "rf-1", kind: "void" });
  syncInvoiceForBooking.mockClear();
  notifyBookingConfirmation.mockClear();
  rpcs = {
    pay_link_lookup: ok(ACTIVE),
    pay_link_begin_charge: ok({ state: "ok", link_id: LINK, booking_id: BOOKING, request_id: REQ, amount: 348.3 }),
    record_pay_link_payment: ok("recorded"),
  };
});

const pay = async (over: Record<string, unknown> = {}) => {
  const { payWithLink } = await import("./pay");
  return payWithLink({ token: TOKEN, paymentToken: "tok", expectedTotal: 348.3, agreement: true, smsOptIn: false, clientKey: "ck", ...over });
};
const called = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);
const PaymentErrorOf = async () => (await import("@/lib/quickbooks/payments")).PaymentError;

describe("payWithLink", () => {
  it("happy path: charges the SAVED total with the server's Request-Id, records, syncs, confirms", async () => {
    const r = await pay({ smsOptIn: true });
    expect(r).toEqual({ ok: true, code: "paid" });
    expect(createCharge).toHaveBeenCalledWith(expect.objectContaining({ amount: "348.30", token: "tok", idempotencyKey: REQ }));
    expect(called("pay_link_begin_charge")[0]).toEqual({ p_token: TOKEN, p_expected_total: 348.3, p_agreement: true });
    expect(called("record_pay_link_payment")[0]).toEqual({ p_link_id: LINK, p_request_id: REQ, p_qb_charge_id: "ch-1", p_amount: 348.3, p_sms_opt_in: true });
    expect(syncInvoiceForBooking).toHaveBeenCalledWith(BOOKING);
    expect(notifyBookingConfirmation).toHaveBeenCalledWith(BOOKING);
    expect(refundCharge).not.toHaveBeenCalled();
  });

  it.each([
    ["throttled", { state: "throttled" }, "throttled"],
    ["not_found", { state: "not_found" }, "not_found"],
  ])("lookup %s: no charge", async (_n, lookup, code) => {
    rpcs.pay_link_lookup = ok(lookup);
    const r = await pay();
    expect(r.code).toBe(code);
    expect(createCharge).not.toHaveBeenCalled();
    expect(called("pay_link_begin_charge")).toHaveLength(0);
  });

  it("an already-paid link reports paid without charging", async () => {
    rpcs.pay_link_lookup = ok({ state: "paid" });
    expect(await pay()).toEqual({ ok: true, code: "already_paid" });
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("a malformed token is looked up as empty (still counted), never passed through", async () => {
    rpcs.pay_link_lookup = ok({ state: "not_found" });
    await pay({ token: "../../etc" });
    expect(called("pay_link_lookup")[0]).toEqual({ p_token: "", p_client_key: "ck" });
  });

  it.each([
    ["no_agreement", { state: "no_agreement" }],
    ["amount_changed", { state: "amount_changed", total: 400 }],
    ["in_progress", { state: "in_progress" }],
  ])("begin %s: no charge, says so", async (code, began) => {
    rpcs.pay_link_begin_charge = ok(began);
    const r = await pay();
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    if (code === "amount_changed") expect(r).toMatchObject({ total: 400 });
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("declined: clears the in-flight mark, records a declined attempt, no refund, no record", async () => {
    const PaymentError = await PaymentErrorOf();
    createCharge.mockRejectedValue(new PaymentError("Card declined: insufficient funds", "PMT-4000", true));
    const r = await pay();
    expect(r).toMatchObject({ ok: false, code: "declined", message: "Card declined: insufficient funds" });
    expect(createCharge).toHaveBeenCalledTimes(1);
    expect(called("pay_link_clear_charge")[0]).toEqual({ p_link_id: LINK, p_request_id: REQ });
    expect(called("record_payment_attempt")[0]).toMatchObject({ p_kind: "declined", p_context: expect.objectContaining({ booking_id: BOOKING, pay_link_id: LINK }) });
    expect(called("record_pay_link_payment")).toHaveLength(0);
  });

  it("unknown charge outcome: retries ONCE with the same Request-Id, then carries on", async () => {
    createCharge.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValueOnce({ chargeId: "ch-1" });
    const r = await pay();
    expect(r).toEqual({ ok: true, code: "paid" });
    expect(createCharge).toHaveBeenCalledTimes(2);
    expect(createCharge.mock.calls.every(([a]) => (a as { idempotencyKey: string }).idempotencyKey === REQ)).toBe(true);
  });

  it("still unknown after the retry: leaves the link in flight (no clear), records an error, tells them not to retry", async () => {
    createCharge.mockRejectedValue(new Error("timeout"));
    const r = await pay();
    expect(r.code).toBe("unconfirmed");
    expect(called("pay_link_clear_charge")).toHaveLength(0);
    expect(called("record_payment_attempt")[0]).toMatchObject({ p_kind: "error" });
    expect(refundCharge).not.toHaveBeenCalled();
  });

  it.each(["refused_cancelled", "refused_paid", "refused_link", "refused_amount"])(
    "record %s: refunds the charge, records the compensation, tells them they weren't charged",
    async (refused) => {
      rpcs.record_pay_link_payment = ok(refused);
      const r = await pay();
      expect(r).toMatchObject({ ok: false, code: "compensated", refunded: true });
      expect(r.message).toContain("you have not been charged");
      expect(refundCharge).toHaveBeenCalledWith({ chargeId: "ch-1", amount: "348.30" });
      expect(called("record_payment_attempt")[0]).toMatchObject({
        p_kind: "compensating_refund",
        p_qb_charge_id: "ch-1",
        p_qb_refund_id: "rf-1",
        p_context: expect.objectContaining({ refused, refund_succeeded: true, refund_kind: "void", booking_id: BOOKING }),
      });
      expect(notifyBookingConfirmation).not.toHaveBeenCalled();
    },
  );

  it("refund itself fails: says a refund is being processed, records refund_succeeded false (needs-action)", async () => {
    rpcs.record_pay_link_payment = ok("refused_cancelled");
    refundCharge.mockRejectedValue(new Error("Intuit down"));
    const r = await pay();
    expect(r).toMatchObject({ code: "compensated", refunded: false });
    expect(r.message).toContain("refund is being processed");
    expect(called("record_payment_attempt")[0]).toMatchObject({
      p_kind: "compensating_refund",
      p_qb_refund_id: null,
      p_context: expect.objectContaining({ refund_succeeded: false }),
    });
  });

  it("record errored but the payment DID commit (read back): success, no refund", async () => {
    rpcs.record_pay_link_payment = () => ({ data: null, error: { message: "connection reset" } });
    readBack = { status: "paid", qb_charge_id: "ch-1" };
    expect(await pay()).toEqual({ ok: true, code: "paid" });
    expect(refundCharge).not.toHaveBeenCalled();
  });

  it("record errored and it did NOT commit: refunds", async () => {
    rpcs.record_pay_link_payment = () => ({ data: null, error: { message: "connection reset" } });
    readBack = { status: "active", qb_charge_id: "" };
    const r = await pay();
    expect(r).toMatchObject({ code: "compensated", refunded: true });
    expect(refundCharge).toHaveBeenCalledTimes(1);
  });

  it("already_recorded (a replay): success without a second confirmation", async () => {
    rpcs.record_pay_link_payment = ok("already_recorded");
    expect(await pay()).toEqual({ ok: true, code: "paid" });
    expect(notifyBookingConfirmation).not.toHaveBeenCalled();
  });

  it("a failing invoice sync never fails the customer", async () => {
    syncInvoiceForBooking.mockRejectedValueOnce(new Error("QBO down"));
    expect(await pay()).toEqual({ ok: true, code: "paid" });
  });
});
