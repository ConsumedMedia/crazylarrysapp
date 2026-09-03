import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createBooking, BookingCreateError } from "./create";
import { createCharge, refundCharge, PaymentError } from "@/lib/quickbooks/payments";
import { syncInvoiceForBooking } from "@/lib/quickbooks/invoices";
import type { CreateBookingInput } from "./types";

export interface CheckoutResult {
  ok: boolean;
  bookingId?: string;
  error?: string;
  code?: string;
  /** true only when money was captured and then fully returned (race case). */
  refunded?: boolean;
}

/**
 * The real Review & Pay pipeline — replaces the Phase 4 dev stub.
 *
 *   1. authoritative quote (server-side, never trust the client amount)
 *   2. charge the tokenized card
 *      └─ declined  -> record_payment_attempt('declined'), no booking, stop
 *   3. create_booking (atomic)
 *      └─ throws    -> compensating refund + record_payment_attempt('compensating_refund'),
 *                      tell the customer they were not charged
 *   4. record_payment (invoices row + bookings.payment_status='paid')
 *   5. best-effort QBO invoice sync (cron retries on failure)
 */
export async function payAndBook(
  input: CreateBookingInput,
  payment: { token: string; idempotencyKey: string },
): Promise<CheckoutResult> {
  const service = createServiceClient();

  // ---- 1. authoritative amount -----------------------------------------
  const { data: quoteRows, error: quoteErr } = await service.rpc("booking_quote", {
    p_size: input.size,
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
      description: `Crazy Larry's — ${String(input.size).replace("yd", " yd")} dumpster`,
    });
  } catch (e) {
    const pe = e instanceof PaymentError ? e : null;
    await service.rpc("record_payment_attempt", {
      p_kind: "declined",
      p_qb_charge_id: null,
      p_qb_refund_id: null,
      p_amount: Number(amount),
      p_contact_email: input.contactEmail ?? null,
      p_reason: pe?.message ?? "charge failed",
      p_context: {
        code: pe?.code ?? "error",
        size: input.size,
        delivery_date: input.deliveryDate,
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
    ({ bookingId } = await createBooking(input));
  } catch (e) {
    // Money is captured but there's no booking — compensate immediately.
    let refundId: string | null = null;
    let refundOk = false;
    try {
      const r = await refundCharge({ chargeId: charge.chargeId, amount });
      refundId = r.refundId;
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
      p_contact_email: input.contactEmail ?? null,
      p_reason:
        e instanceof BookingCreateError ? e.message : "booking creation failed",
      p_context: {
        booking_error_code: e instanceof BookingCreateError ? e.code : "error",
        refund_succeeded: refundOk,
        size: input.size,
        delivery_date: input.deliveryDate,
      },
    });
    return {
      ok: false,
      code: "compensated",
      refunded: refundOk,
      error: refundOk
        ? "That date filled up while you were checking out, so the booking didn't go through — you have not been charged (the card authorization has been reversed). Please pick another day."
        : "That date filled up while you were checking out and the booking didn't go through. A refund is being processed — contact the yard if you don't see it within a few days.",
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

  return { ok: true, bookingId };
}
