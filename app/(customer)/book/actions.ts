"use server";

import { payAndBook, type CheckoutResult } from "@/lib/bookings/checkout";
import type { CreateBookingInput } from "@/lib/bookings/types";
import {
  startAgreementSession,
  verifyAgreementSession,
} from "@/lib/docusign/agreement";
import { effectiveAgreementMode, MODE_CHANGED } from "@/lib/docusign/mode";
import { requestReturnOrigin } from "@/lib/docusign/return-origin";

export type { CheckoutResult };

/**
 * Review & Pay submit. The card was already tokenized in the browser against
 * Intuit's /tokens endpoint — only the opaque `paymentToken` reaches us here,
 * never card data. `idempotencyKey` is generated once per checkout mount and
 * reused as the charge Request-Id so a double-submit can't double-charge.
 *
 * The agreement mode is decided HERE, on the server, for every request
 * (effectiveAgreementMode: the owner's setting AND this deployment's DocuSign
 * capability), never taken from the browser.
 *
 *   attest    users-page's action, unchanged: the PowerForm checkbox must be
 *             ticked, then payAndBook with no agreement session.
 *   docusign  payAndBook refuses before any charge unless `agreementSessionId`
 *             is a DocuSign-verified, unused session signed with this
 *             booking's email. Nothing the browser claims is trusted.
 *
 * Each wizard sends only its own field (attest: agreementAcknowledged;
 * DocuSign: agreementSessionId). A page loaded under the other mode gets
 * agreement_mode_changed before anything is touched, and is asked to reload.
 */
export async function payAndBookAction(
  input: CreateBookingInput & {
    agreementAcknowledged?: boolean;
    agreementSessionId?: string | null;
    paymentToken: string;
    idempotencyKey: string;
  },
): Promise<CheckoutResult> {
  const mode = await effectiveAgreementMode();
  const fromDocusignPage = "agreementSessionId" in input;
  const fromAttestPage = "agreementAcknowledged" in input;

  if (mode === "attest") {
    if (fromDocusignPage && !fromAttestPage) return { ok: false, ...MODE_CHANGED };
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
    const { paymentToken, idempotencyKey, agreementAcknowledged: _ack, agreementSessionId: _s, ...bookingInput } = input;
    void _ack;
    void _s;
    return payAndBook(bookingInput, { token: paymentToken, idempotencyKey }, { mode: "attest" });
  }

  if (fromAttestPage && !fromDocusignPage) return { ok: false, ...MODE_CHANGED };
  if (!input.paymentToken || !input.idempotencyKey) {
    return { ok: false, error: "Payment details are incomplete.", code: "no_token" };
  }
  const { paymentToken, idempotencyKey, agreementSessionId, agreementAcknowledged: _ack, ...bookingInput } = input;
  void _ack;
  return payAndBook(
    bookingInput,
    { token: paymentToken, idempotencyKey },
    { mode: "docusign", sessionId: agreementSessionId },
  );
}

/**
 * Start (or resume) signing: returns a one-time embedded signing URL. Only in
 * DocuSign mode: in attest mode no envelope is ever created (each one counts
 * against the plan's allowance).
 */
export async function startAgreementAction(input: {
  contactName: string;
  contactEmail: string;
  existingSessionId: string | null;
}) {
  if ((await effectiveAgreementMode()) !== "docusign") {
    return { ok: false as const, ...MODE_CHANGED };
  }
  return startAgreementSession({
    signerName: input.contactName,
    signerEmail: input.contactEmail,
    existingSessionId: input.existingSessionId,
    // Back to this request's own (allowlisted) origin, never one the browser names.
    returnOrigin: requestReturnOrigin(),
  });
}

/** Called when the signer returns from DocuSign — confirms with DocuSign itself. */
export async function verifyAgreementAction(sessionId: string) {
  if ((await effectiveAgreementMode()) !== "docusign") {
    return { ok: false, code: MODE_CHANGED.code, error: MODE_CHANGED.error, signerEmail: undefined };
  }
  const r = await verifyAgreementSession(sessionId);
  return { ok: r.ok, code: r.code, error: r.error, signerEmail: r.signerEmail };
}
