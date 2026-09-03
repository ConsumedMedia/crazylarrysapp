import "server-only";
import { randomUUID } from "crypto";
import { getQuickBooksConfig } from "./config";
import { forceExpireAccessToken, getValidAccessToken } from "./tokens";

/**
 * QuickBooks Payments API (charges + refunds).
 *
 * Separate base host from the Accounting API and no /v3/company/{realm} path
 * prefix — the OAuth access token is already realm-scoped, so charges need only
 * the bearer plus a Request-Id idempotency header.
 *
 * Card data never reaches this layer: the browser tokenizes the card directly
 * against Intuit's /tokens endpoint and only the opaque token is passed here.
 */

async function paymentsFetch(
  path: string,
  init: RequestInit & { requestId?: string } = {},
): Promise<Response> {
  const { paymentsBaseUrl } = getQuickBooksConfig();
  const { requestId, ...rest } = init;

  const doFetch = async (accessToken: string) =>
    fetch(`${paymentsBaseUrl}/quickbooks/v4/payments/${path.replace(/^\//, "")}`, {
      ...rest,
      headers: {
        ...(rest.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Request-Id": requestId ?? randomUUID(),
      },
      cache: "no-store",
    });

  const first = await getValidAccessToken();
  let res = await doFetch(first.accessToken);
  if (res.status === 401) {
    await forceExpireAccessToken();
    const retry = await getValidAccessToken();
    res = await doFetch(retry.accessToken);
  }
  return res;
}

export class PaymentError extends Error {
  code: string;
  declined: boolean;
  constructor(message: string, code = "payment_error", declined = false) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
    this.declined = declined;
  }
}

/** Parse Intuit's { errors: [{ code, type, detail }] } shape. */
function readErrors(body: unknown): { code: string; detail: string } | null {
  const errs = (body as { errors?: Array<Record<string, string>> })?.errors;
  if (!Array.isArray(errs) || errs.length === 0) return null;
  const e = errs[0];
  return {
    code: e.code ?? "unknown",
    detail: [e.detail, e.moreInfo].filter(Boolean).join(" ") || e.type || "declined",
  };
}

export interface ChargeResult {
  chargeId: string;
  status: string; // "CAPTURED"
  authCode: string | null;
  cardType: string | null;
  cardNumberMasked: string | null;
}

/**
 * Charge a tokenized card. `amount` is a decimal string, e.g. "234.50".
 * `idempotencyKey` is reused as the Request-Id so a double-submit can't
 * double-charge.
 */
export async function createCharge(opts: {
  amount: string;
  token: string;
  idempotencyKey: string;
  description?: string;
}): Promise<ChargeResult> {
  const res = await paymentsFetch("charges", {
    method: "POST",
    requestId: opts.idempotencyKey,
    body: JSON.stringify({
      amount: opts.amount,
      currency: "USD",
      token: opts.token,
      context: { mobile: false, isEcommerce: true },
      ...(opts.description ? { description: opts.description } : {}),
    }),
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    const err = readErrors(body);
    // 400/402 with an errors array is a decline or a bad request.
    throw new PaymentError(
      err ? `Card declined: ${err.detail}` : `Charge failed (${res.status})`,
      err?.code ?? `http_${res.status}`,
      res.status === 400 || res.status === 402,
    );
  }

  const status = String(body.status ?? "");
  if (status === "DECLINED") {
    throw new PaymentError("Card declined.", "declined", true);
  }
  if (!body.id) {
    throw new PaymentError("Charge returned no id.", "no_id", false);
  }

  const card = (body.card ?? {}) as Record<string, unknown>;
  return {
    chargeId: String(body.id),
    status,
    authCode: (body.authCode as string) ?? null,
    cardType: (card.cardType as string) ?? null,
    cardNumberMasked: (card.number as string) ?? null,
  };
}

export interface RefundResult {
  refundId: string;
  status: string; // "ISSUED"
  /** What Intuit actually did: 'void' before settlement, 'refund' after. */
  kind: "void" | "refund";
  rawType: string; // "VOID" | "REFUND"
}

/**
 * Refund (or void) a charge. Intuit decides which based on whether the charge
 * has settled — the same endpoint does both. The response `type` field tells
 * us which happened; we store it verbatim as refund_kind. Staff never choose.
 */
export async function refundCharge(opts: {
  chargeId: string;
  amount: string;
  idempotencyKey?: string;
}): Promise<RefundResult> {
  const res = await paymentsFetch(`charges/${opts.chargeId}/refunds`, {
    method: "POST",
    requestId: opts.idempotencyKey,
    body: JSON.stringify({ amount: opts.amount }),
  });

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }

  if (!res.ok) {
    const err = readErrors(body);
    throw new PaymentError(
      err ? `Refund failed: ${err.detail}` : `Refund failed (${res.status})`,
      err?.code ?? `http_${res.status}`,
      false,
    );
  }

  const rawType = String(body.type ?? "REFUND").toUpperCase();
  return {
    refundId: String(body.id ?? ""),
    status: String(body.status ?? ""),
    kind: rawType === "VOID" ? "void" : "refund",
    rawType,
  };
}
