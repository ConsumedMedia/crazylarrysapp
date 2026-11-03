"use server";

import { headers } from "next/headers";
import { payWithLink, type PayResult } from "@/lib/pay-links/pay";
import { clientIpFrom, clientKeyFor } from "@/lib/pay-links/token";

export type { PayResult };

/**
 * /pay submit. No session is read or used: the link token is the only
 * credential, and every rule (live link, unpaid, open, same total, agreement
 * ticked, one charge at a time) is enforced by the database RPCs under lock.
 * The card was tokenized in the browser against Intuit — only the opaque
 * `paymentToken` reaches us. The amount charged is the SAVED booking total;
 * `expectedTotal` is only compared against it.
 */
export async function payLinkAction(input: {
  token: string;
  paymentToken: string;
  expectedTotal: number;
  agreement: boolean;
  smsOptIn: boolean;
}): Promise<PayResult> {
  if (
    typeof input?.token !== "string" ||
    typeof input.paymentToken !== "string" ||
    typeof input.expectedTotal !== "number" ||
    !Number.isFinite(input.expectedTotal)
  ) {
    return { ok: false, code: "error", message: "Payment details are incomplete." };
  }
  return payWithLink({
    token: input.token,
    paymentToken: input.paymentToken,
    expectedTotal: input.expectedTotal,
    agreement: input.agreement === true,
    smsOptIn: input.smsOptIn === true,
    clientKey: clientKeyFor(clientIpFrom(headers())),
  });
}
