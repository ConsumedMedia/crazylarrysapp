"use server";

import { payAndBook, type CheckoutResult } from "@/lib/bookings/checkout";
import type { CreateBookingInput } from "@/lib/bookings/types";

export type { CheckoutResult };

/**
 * Review & Pay submit. The card was already tokenized in the browser against
 * Intuit's /tokens endpoint — only the opaque `paymentToken` reaches us here,
 * never card data. `idempotencyKey` is generated once per checkout mount and
 * reused as the charge Request-Id so a double-submit can't double-charge.
 */
export async function payAndBookAction(
  input: CreateBookingInput & {
    agreementAcknowledged: boolean;
    paymentToken: string;
    idempotencyKey: string;
  },
): Promise<CheckoutResult> {
  if (!input.agreementAcknowledged) {
    return {
      ok: false,
      error: "Please open and complete the rental agreement first.",
      code: "agreement",
    };
  }
  if (!input.paymentToken || !input.idempotencyKey) {
    return { ok: false, error: "Payment details are incomplete.", code: "no_token" };
  }

  const { paymentToken, idempotencyKey, ...rest } = input;
  const { agreementAcknowledged: _ack, ...bookingInput } = rest;
  void _ack;

  return payAndBook(bookingInput, { token: paymentToken, idempotencyKey });
}
