import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createBooking, normalizeBookingInput, BookingCreateError } from "./create";
import { cutoffClosedMessage, getDeliveryFloor, isClosedByCutoff } from "./cutoff";
import { createCharge, refundCharge, PaymentError } from "@/lib/quickbooks/payments";
import { syncInvoiceForBooking } from "@/lib/quickbooks/invoices";
import { notifyBookingConfirmation } from "@/lib/notifications/notify";
import type { CreateBookingInput } from "./types";

export interface CheckoutResult {
  ok: boolean;
  bookingId?: string;
  error?: string;
  code?: string;
  /** For code "compensated": why the booking was refused after the charge. */
  reason?: string;
  /** true only when money was captured and then fully returned (race case). */
  refunded?: boolean;
}

const NOT_CHARGED = "you have not been charged (the card authorization has been reversed).";
const REFUND_PENDING = "A refund is being processed — contact the yard if you don't see it within a few days.";

/**
 * What the customer is told when the database refuses the booking after the
 * card was charged. "Filled up" is said only for a real capacity refusal.
 */
export function compensationMessage(reason: string, refundOk: boolean): string {
  switch (reason) {
    case "unavailable":
      return refundOk
        ? `That date filled up while you were checking out, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`
        : `That date filled up while you were checking out and the booking didn't go through. ${REFUND_PENDING}`;
    case "past_date":
      return refundOk
        ? `Delivery must be tomorrow or later, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`
        : `Delivery must be tomorrow or later, so the booking didn't go through. ${REFUND_PENDING}`;
    case "after_cutoff":
      return refundOk
        ? `Orders placed after the cutoff can't be delivered tomorrow, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`
        : `Orders placed after the cutoff can't be delivered tomorrow, so the booking didn't go through. ${REFUND_PENDING}`;
    case "blocked":
      return refundOk
        ? `That date is no longer available, so the booking didn't go through — ${NOT_CHARGED} Please pick another day.`
        : `That date is no longer available, so the booking didn't go through. ${REFUND_PENDING}`;
    default:
      return refundOk
        ? `Something went wrong and the booking didn't go through — ${NOT_CHARGED} Please try again or call the yard.`
        : `Something went wrong and the booking didn't go through. ${REFUND_PENDING}`;
  }
}

/**
 * The real Review & Pay pipeline — replaces the Phase 4 dev stub.
 *
 *   0. validate everything that needs no database (size, date format, the
 *      yard's tomorrow, rental length, address, contact) and the order
 *      cutoff (booking_delivery_floor, the database's own rule; unreadable =
 *      today's rule) — all refused before any charge; the normalized params
 *      are used from here on. The database enforces the cutoff again with a
 *      10-minute grace, so it never refuses after the charge a day this
 *      check approved moments earlier.
 *   1. authoritative quote (server-side, never trust the client amount)
 *   2. charge the tokenized card
 *      └─ declined  -> record_payment_attempt('declined'), no booking, stop
 *   3. create_booking (atomic: date floor, blocks and capacity under its lock)
 *      └─ throws    -> compensating refund + record_payment_attempt('compensating_refund'),
 *                      tell the customer why and that they were not charged
 *   4. record_payment (invoices row + bookings.payment_status='paid')
 *   5. best-effort QBO invoice sync (cron retries on failure)
 */
export async function payAndBook(
  input: CreateBookingInput,
  payment: { token: string; idempotencyKey: string },
): Promise<CheckoutResult> {
  // ---- 0. validate, before the card is touched ---------------------------
  let params;
  try {
    params = normalizeBookingInput(input);
  } catch (e) {
    if (e instanceof BookingCreateError) {
      return { ok: false, code: e.code, error: e.message };
    }
    throw e;
  }
  const floor = await getDeliveryFloor();
  if (isClosedByCutoff(params.p_delivery_date, floor)) {
    return { ok: false, code: "after_cutoff", error: cutoffClosedMessage(floor) };
  }

  const service = createServiceClient();

  // ---- 1. authoritative amount -----------------------------------------
  const { data: quoteRows, error: quoteErr } = await service.rpc("booking_quote", {
    p_size: params.p_size,
  });
  const quote = Array.isArray(quoteRows) ? quoteRows[0] : quoteRows;
  if (quoteErr || !quote) {
    return {
      ok: false,
      code: "pricing_not_configured",
      error: "Online booking is temporarily unavailable — please call the yard.",
    };
  }
  const amount = Number(quote.total).toFixed(2);

  // ---- 2. charge -------------------------------------------------------
  let charge;
  try {
    charge = await createCharge({
      amount,
      token: payment.token,
      idempotencyKey: payment.idempotencyKey,
      description: `Crazy Larry's — ${params.p_size.replace("yd", " yd")} dumpster`,
    });
  } catch (e) {
    const pe = e instanceof PaymentError ? e : null;
    await service.rpc("record_payment_attempt", {
      p_kind: "declined",
      p_qb_charge_id: null,
      p_qb_refund_id: null,
      p_amount: Number(amount),
      p_contact_email: params.p_contact_email,
      p_reason: pe?.message ?? "charge failed",
      p_context: {
        code: pe?.code ?? "error",
        size: params.p_size,
        delivery_date: params.p_delivery_date,
      },
    });
    return {
      ok: false,
      code: "declined",
      error:
        pe?.message ??
        "That payment didn't go through. Check the card details and try again.",
    };
  }

  // ---- 3. create the booking atomically -------------------------------
  let bookingId: string;
  try {
    ({ bookingId } = await createBooking(params));
  } catch (e) {
    // Money is captured but there's no booking — compensate immediately.
    const reason = e instanceof BookingCreateError ? e.code : "error";
    let refundId: string | null = null;
    // Intuit decides: "void" before settlement, "refund" after.
    let refundKind: "void" | "refund" | null = null;
    let refundOk = false;
    try {
      const r = await refundCharge({ chargeId: charge.chargeId, amount });
      refundId = r.refundId;
      refundKind = r.kind;
      refundOk = true;
    } catch (re) {
      console.error(
        "[checkout] compensating refund FAILED for charge",
        charge.chargeId,
        (re as Error).message,
      );
    }
    await service.rpc("record_payment_attempt", {
      p_kind: "compensating_refund",
      p_qb_charge_id: charge.chargeId,
      p_qb_refund_id: refundId,
      p_amount: Number(amount),
      p_contact_email: params.p_contact_email,
      p_reason:
        e instanceof BookingCreateError ? e.message : "booking creation failed",
      p_context: {
        booking_error_code: reason,
        refund_succeeded: refundOk,
        refund_kind: refundKind,
        size: params.p_size,
        delivery_date: params.p_delivery_date,
      },
    });
    return {
      ok: false,
      code: "compensated",
      reason,
      refunded: refundOk,
      error: compensationMessage(reason, refundOk),
    };
  }

  // ---- 4. record the payment ----------------------------------------
  const { error: payErr } = await service.rpc("record_payment", {
    p_booking_id: bookingId,
    p_qb_charge_id: charge.chargeId,
    p_qb_payment_id: null, // QBO Payment object id is filled in by the invoice sync
    p_amount: Number(amount),
  });
  if (payErr) {
    // Booking exists and card is charged; this is a bookkeeping write failure.
    // Log loudly but let the customer through — reconcile can repair it.
    console.error(
      "[checkout] record_payment failed for booking",
      bookingId,
      "charge",
      charge.chargeId,
      payErr.message,
    );
  }

  // ---- 5. QBO invoice sync (best-effort) ---------------------------
  try {
    await syncInvoiceForBooking(bookingId);
  } catch (e) {
    console.error("[checkout] invoice sync threw:", (e as Error).message);
  }

  // ---- 6. confirmation email + SMS (never throws) -----------------
  await notifyBookingConfirmation(bookingId);

  return { ok: true, bookingId };
}
