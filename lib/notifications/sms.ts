import "server-only";
import { toE164US } from "./phone";
import { isReservedPhone } from "./reserved";
import { resolveTestRedirect } from "./test-mode";

/**
 * Quo (formerly OpenPhone) SMS. POST https://api.quo.com/v1/messages
 * Auth: the raw API key in the Authorization header (NOT "Bearer ...").
 *
 * Never throws. Returns a tagged result the notify layer records in
 * notifications_log. A disabled feature flag, a missing key, an unparseable
 * number, provider downtime, or a non-2xx response all come back as { ok:false }.
 */

const QUO_URL = "https://api.quo.com/v1/messages";
const TIMEOUT_MS = 8000;

/**
 * Buckets a failed/skipped send for notification_health(): 'account_blocked'
 * and 'not_configured' mean "a human needs to fix the account/env" — every
 * other category is noise (one bad number, a blip) that shouldn't page anyone.
 */
export type FailureCategory =
  | "disabled"
  | "test_mode"
  | "not_configured"
  | "account_blocked"
  | "provider_rejected"
  | "rate_limited"
  | "transient"
  | "recipient_missing"
  | "no_consent"
  /** The number replied STOP, or a reply that may be one awaits staff review (Plan B.4); or Quo itself says the number opted out. */
  | "opted_out";

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  skipped?: boolean;
  category?: FailureCategory;
  /**
   * Set once a provider call is attempted: the address/number actually sent
   * to, and whether test mode (CL_NOTIFICATIONS_TEST_PHONE / _EMAIL / _TO)
   * redirected it away from the intended recipient. notify.ts logs the real destination from these.
   */
  sentTo?: string;
  redirected?: boolean;
  /** When redirected: the variable whose value it went to (a name, never the value). */
  redirectedVia?: string;
}

export function smsEnabled(): boolean {
  return (
    process.env.CL_NOTIFICATIONS_ENABLED === "1" &&
    !!process.env.QUO_API_KEY &&
    !!process.env.QUO_FROM_NUMBER
  );
}

/** Quo 400s for A2P/10DLC registration read like "org is not approved for A2P". */
function categorizeQuoError(status: number, detail: string): FailureCategory {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  // Quo's 400 "User Opted Out" / "User has opted out of receiving messages".
  if (/opted[\s_-]?out/i.test(detail)) return "opted_out";
  if (/a2p|10dlc|not approved|registration|carrier/i.test(detail)) {
    return "account_blocked";
  }
  return "provider_rejected";
}

export async function sendSms(
  toE164: string,
  content: string,
): Promise<SendResult> {
  if (process.env.CL_NOTIFICATIONS_ENABLED !== "1") {
    return {
      ok: false,
      skipped: true,
      category: "disabled",
      error: "notifications disabled (dev)",
    };
  }
  const key = process.env.QUO_API_KEY;
  if (!key || !process.env.QUO_FROM_NUMBER) {
    return {
      ok: false,
      skipped: false,
      category: "not_configured",
      error: "QUO_API_KEY / QUO_FROM_NUMBER not set",
    };
  }

  // Quo requires clean E.164 for both ends — normalize whatever's in the env.
  const from = toE164US(process.env.QUO_FROM_NUMBER);
  if (!from) {
    return {
      ok: false,
      category: "not_configured",
      error: `QUO_FROM_NUMBER is not a valid US number: "${process.env.QUO_FROM_NUMBER}" (want +1XXXXXXXXXX)`,
    };
  }

  // A reserved fictional number is never sent to, redirected or not, so test
  // mode behaves the way production will once the test variables are cleared.
  if (isReservedPhone(toE164)) {
    return {
      ok: false,
      skipped: true,
      category: "recipient_missing",
      error: "reserved test number (555-01xx) — not sent",
    };
  }

  // Test mode (any of CL_NOTIFICATIONS_TEST_PHONE / _EMAIL / _TO set): only the
  // test phone, never the customer. See test-mode.ts for the rules.
  const redirect = resolveTestRedirect("sms");
  if (redirect.mode === "skip") {
    return {
      ok: false,
      skipped: redirect.category === "test_mode",
      category: redirect.category,
      error: redirect.reason,
    };
  }
  const to = redirect.mode === "redirect" ? redirect.to : toE164;
  const delivery = {
    sentTo: to,
    redirected: redirect.mode === "redirect",
    ...(redirect.mode === "redirect" ? { redirectedVia: redirect.via } : {}),
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(QUO_URL, {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ from, to: [to], content }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail =
          j?.message || j?.errors?.[0]?.message || j?.error || detail;
      } catch {
        /* keep raw */
      }
      return {
        ok: false,
        category: categorizeQuoError(res.status, detail),
        error: `Quo ${res.status}: ${detail}`,
        ...delivery,
      };
    }

    let id: string | undefined;
    try {
      const j = JSON.parse(text);
      id = j?.data?.id ?? j?.id;
    } catch {
      /* 202 with empty body is fine */
    }
    return { ok: true, providerMessageId: id, ...delivery };
  } catch (e) {
    const isTimeout = (e as Error).name === "AbortError";
    return {
      ok: false,
      category: "transient",
      error: (isTimeout ? "Quo request timed out" : (e as Error).message).slice(0, 300),
      ...delivery,
    };
  }
}
