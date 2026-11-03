import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createCharge, refundCharge, PaymentError } from "@/lib/quickbooks/payments";
import { syncInvoiceForBooking } from "@/lib/quickbooks/invoices";
import { notifyBookingConfirmation } from "@/lib/notifications/notify";
import { isPayToken } from "./token";

/**
 * The public /pay/<token> side. Runs with the service-role client only — the
 * page has no session and must not use one (a staff member's browser may be
 * signed in). Every read and write goes through the pay_link_* RPCs, which
 * hold the locks and the rules; this file sequences them around the card
 * charge, the same shape as payAndBook (lib/bookings/checkout.ts):
 *
 *   1. lookup        (rate-limited, counts this visitor)
 *   2. begin_charge  (locks booking + link: open, unpaid, same total, agreement
 *                     ticked, no charge in flight; hands out the Request-Id)
 *   3. charge        declined -> clear_charge, record 'declined', stop
 *                    unknown  -> retry ONCE with the same Request-Id (Intuit
 *                                returns the original charge if it happened)
 *   4. record_pay_link_payment
 *                    refused / unknown -> refund (compensating), record it,
 *                                tell the customer
 *   5. QBO invoice sync (best effort) + paid confirmation (never throws)
 */

export interface PayLinkView {
  state: "active";
  linkId: string;
  bookingId: string;
  firstName: string;
  size: string;
  deliveryDate: string;
  pickupDate: string;
  deliveryAddress: string;
  subtotal: number;
  tax: number;
  total: number;
}

export type PayLinkLookup =
  | PayLinkView
  | { state: "paid" }
  | { state: "not_found" }
  | { state: "throttled" }
  | { state: "error" };

export async function lookupPayLink(token: string, clientKey: string): Promise<PayLinkLookup> {
  if (!isPayToken(token)) {
    // Still counted against the visitor, so malformed guesses are throttled too.
    token = "";
  }
  const service = createServiceClient();
  const { data, error } = await service.rpc("pay_link_lookup", {
    p_token: token,
    p_client_key: clientKey,
  });
  if (error || !data) {
    console.error("[pay-link] lookup failed:", error?.message);
    return { state: "error" };
  }
  const r = data as Record<string, unknown>;
  if (r.state !== "active") return { state: r.state as "paid" | "not_found" | "throttled" };
  return {
    state: "active",
    linkId: String(r.link_id),
    bookingId: String(r.booking_id),
    firstName: String(r.first_name ?? ""),
    size: String(r.size),
    deliveryDate: String(r.delivery_date),
    pickupDate: String(r.pickup_date),
    deliveryAddress: String(r.delivery_address),
    subtotal: Number(r.subtotal),
    tax: Number(r.tax),
    total: Number(r.total),
  };
}

export interface PayResult {
  ok: boolean;
  /** For the page: what to show next. */
  code?:
    | "paid"
    | "already_paid"
    | "not_found"
    | "throttled"
    | "no_agreement"
    | "amount_changed"
    | "in_progress"
    | "declined"
    | "unconfirmed"
    | "compensated"
    | "error";
  message?: string;
  /** code "amount_changed": the saved total to show instead. */
  total?: number;
  /** code "compensated": true when the money went back. */
  refunded?: boolean;
}

const CALL = "Please call the yard.";
const REFUND_PENDING =
  "A refund is being processed — contact the yard if you don't see it within a few days.";

/** What the customer is told when the booking refused the captured charge. */
export function payLinkRefusalMessage(refused: string, refundOk: boolean): string {
  const why =
    refused === "refused_cancelled"
      ? "This booking was cancelled"
      : refused === "refused_paid"
        ? "This booking is already paid"
        : refused === "refused_amount"
          ? "The amount on this booking changed"
          : "This payment link was replaced or stopped";
  return refundOk
    ? `${why}, so the payment didn't go through — you have not been charged (the card authorization has been reversed). ${CALL}`
    : `${why}, so the payment didn't go through. ${REFUND_PENDING}`;
}

export async function payWithLink(input: {
  token: string;
  paymentToken: string;
  expectedTotal: number;
  agreement: boolean;
  smsOptIn: boolean;
  clientKey: string;
}): Promise<PayResult> {
  if (!input.paymentToken) {
    return { ok: false, code: "error", message: "Payment details are incomplete." };
  }

  // ---- 1. lookup (rate limit) ---------------------------------------------
  const view = await lookupPayLink(input.token, input.clientKey);
  if (view.state === "paid") return { ok: true, code: "already_paid" };
  if (view.state === "throttled") {
    return { ok: false, code: "throttled", message: "Too many attempts — try again in a few minutes." };
  }
  if (view.state !== "active") {
    return { ok: false, code: view.state === "error" ? "error" : "not_found", message: `This payment link isn't active. ${CALL}` };
  }

  const service = createServiceClient();

  // ---- 2. begin (locks, agreement time, Request-Id) ------------------------
  const { data: began, error: beginErr } = await service.rpc("pay_link_begin_charge", {
    p_token: input.token,
    p_expected_total: input.expectedTotal,
    p_agreement: input.agreement === true,
  });
  if (beginErr || !began) {
    console.error("[pay-link] begin_charge failed:", beginErr?.message);
    return { ok: false, code: "error", message: `Something went wrong — you have not been charged. ${CALL}` };
  }
  const b = began as Record<string, unknown>;
  switch (b.state) {
    case "ok":
      break;
    case "paid":
      return { ok: true, code: "already_paid" };
    case "no_agreement":
      return { ok: false, code: "no_agreement", message: "Please open and accept the rental agreement first." };
    case "amount_changed":
      return {
        ok: false,
        code: "amount_changed",
        total: Number(b.total),
        message: `The amount for this booking is now $${Number(b.total).toFixed(2)}. Check it and try again — you have not been charged.`,
      };
    case "in_progress":
      return {
        ok: false,
        code: "in_progress",
        message: "A payment for this booking is already being processed. Wait a minute, then reload this page.",
      };
    default:
      return { ok: false, code: "not_found", message: `This payment link isn't active. ${CALL}` };
  }
  const linkId = String(b.link_id);
  const bookingId = String(b.booking_id);
  const requestId = String(b.request_id);
  const amount = Number(b.amount).toFixed(2);
  const context = { booking_id: bookingId, pay_link_id: linkId, source: "pay_link" };

  // ---- 3. charge ----------------------------------------------------------
  const charge = async () =>
    createCharge({
      amount,
      token: input.paymentToken,
      idempotencyKey: requestId,
      description: `Crazy Larry's — ${view.size.replace("yd", " yd")} dumpster`,
    });
  let chargeId: string;
  try {
    try {
      chargeId = (await charge()).chargeId;
    } catch (e) {
      if (e instanceof PaymentError && e.declined) throw e;
      // Unknown outcome (timeout, 5xx): the same Request-Id makes Intuit return
      // the original charge if it was captured, or charge once if it wasn't.
      chargeId = (await charge()).chargeId;
    }
  } catch (e) {
    const pe = e instanceof PaymentError ? e : null;
    if (pe?.declined) {
      await service.rpc("pay_link_clear_charge", { p_link_id: linkId, p_request_id: requestId });
      await service.rpc("record_payment_attempt", {
        p_kind: "declined",
        p_qb_charge_id: null,
        p_qb_refund_id: null,
        p_amount: Number(amount),
        p_contact_email: null,
        p_reason: pe.message,
        p_context: { ...context, code: pe.code },
      });
      return { ok: false, code: "declined", message: pe.message || "That payment didn't go through. Check the card details and try again." };
    }
    // Still unknown after the retry: leave the link marked in-flight (2 min)
    // so a fresh click can't start a second, different charge.
    await service.rpc("record_payment_attempt", {
      p_kind: "error",
      p_qb_charge_id: null,
      p_qb_refund_id: null,
      p_amount: Number(amount),
      p_contact_email: null,
      p_reason: (e as Error).message?.slice(0, 300) ?? "charge failed",
      p_context: { ...context, request_id: requestId },
    });
    return {
      ok: false,
      code: "unconfirmed",
      message: "We couldn't confirm the payment. Please don't try again for a few minutes — reload this page to see if it went through, or call the yard.",
    };
  }

  // ---- 4. record (or refuse and refund) -----------------------------------
  const { data: recorded, error: recErr } = await service.rpc("record_pay_link_payment", {
    p_link_id: linkId,
    p_request_id: requestId,
    p_qb_charge_id: chargeId,
    p_amount: Number(amount),
    p_sms_opt_in: input.smsOptIn === true,
  });

  let outcome = recErr ? null : String(recorded);
  if (recErr) {
    // The write may or may not have committed. Read back before refunding.
    console.error("[pay-link] record_pay_link_payment errored:", recErr.message);
    const { data: link } = await service
      .from("pay_links")
      .select("status, qb_charge_id")
      .eq("id", linkId)
      .maybeSingle();
    outcome = link?.status === "paid" && link.qb_charge_id === chargeId ? "recorded" : "refused_unknown";
  }

  if (outcome !== "recorded" && outcome !== "already_recorded") {
    let refundOk = false;
    let refundId: string | null = null;
    let refundKind: "void" | "refund" | null = null;
    try {
      const r = await refundCharge({ chargeId, amount });
      refundOk = true;
      refundId = r.refundId;
      refundKind = r.kind;
    } catch (re) {
      console.error("[pay-link] compensating refund FAILED for charge", chargeId, (re as Error).message);
    }
    await service.rpc("record_payment_attempt", {
      p_kind: "compensating_refund",
      p_qb_charge_id: chargeId,
      p_qb_refund_id: refundId,
      p_amount: Number(amount),
      p_contact_email: null,
      p_reason: `pay link refused the charge: ${outcome}`,
      p_context: { ...context, refused: outcome, refund_succeeded: refundOk, refund_kind: refundKind },
    });
    return {
      ok: false,
      code: "compensated",
      refunded: refundOk,
      message: payLinkRefusalMessage(String(outcome), refundOk),
    };
  }

  // ---- 5. after payment (never fails the customer) ------------------------
  try {
    await syncInvoiceForBooking(bookingId);
  } catch (e) {
    console.error("[pay-link] invoice sync threw:", (e as Error).message);
  }
  if (outcome === "recorded") await notifyBookingConfirmation(bookingId);

  return { ok: true, code: "paid" };
}
