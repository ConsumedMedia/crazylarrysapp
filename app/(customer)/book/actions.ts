"use server";

import { payAndBook, type CheckoutResult } from "@/lib/bookings/checkout";
import type { CreateBookingInput } from "@/lib/bookings/types";
import {
  startAgreementSession,
  verifyAgreementSession,
} from "@/lib/docusign/agreement";

export type { CheckoutResult };

/**
 * Review & Pay submit. The card was already tokenized in the browser against
 * Intuit's /tokens endpoint — only the opaque `paymentToken` reaches us here,
 * never card data. `idempotencyKey` is generated once per checkout mount and
 * reused as the charge Request-Id so a double-submit can't double-charge.
 *
 * The rental agreement is enforced SERVER-side: payAndBook refuses before any
 * charge unless `agreementSessionId` is a DocuSign-verified, unused session
 * signed with this booking's email. Nothing the browser claims is trusted.
 */
export async function payAndBookAction(
  input: CreateBookingInput & {
    agreementSessionId: string | null;
    paymentToken: string;
    idempotencyKey: string;
  },
): Promise<CheckoutResult> {
  if (!input.paymentToken || !input.idempotencyKey) {
    return { ok: false, error: "Payment details are incomplete.", code: "no_token" };
  }
  const { paymentToken, idempotencyKey, agreementSessionId, ...bookingInput } = input;
  return payAndBook(
    bookingInput,
    { token: paymentToken, idempotencyKey },
    agreementSessionId,
  );
}

/** Start (or resume) signing: returns a one-time embedded signing URL. */
export async function startAgreementAction(input: {
  contactName: string;
  contactEmail: string;
  existingSessionId: string | null;
}) {
  return startAgreementSession({
    signerName: input.contactName,
    signerEmail: input.contactEmail,
    existingSessionId: input.existingSessionId,
  });
}

/** Called when the signer returns from DocuSign — confirms with DocuSign itself. */
export async function verifyAgreementAction(sessionId: string) {
  const r = await verifyAgreementSession(sessionId);
  return { ok: r.ok, code: r.code, error: r.error, signerEmail: r.signerEmail };
}
