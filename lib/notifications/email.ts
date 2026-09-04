import "server-only";
import type { FailureCategory, SendResult } from "./sms";

/**
 * Resend transactional email. POST https://api.resend.com/emails
 * Auth: Bearer RESEND_API_KEY.
 *
 * Never throws — same contract as sendSms.
 */

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

/** Resend's domain-not-verified / account-suspended errors read as 403/422. */
function categorizeResendError(status: number, detail: string): FailureCategory {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  if (/domain is not verified|not verified|suspended|restricted/i.test(detail)) {
    return "account_blocked";
  }
  return "provider_rejected";
}

export function emailEnabled(): boolean {
  return (
    process.env.CL_NOTIFICATIONS_ENABLED === "1" &&
    !!process.env.RESEND_API_KEY &&
    !!process.env.RESEND_FROM
  );
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<SendResult> {
  if (process.env.CL_NOTIFICATIONS_ENABLED !== "1") {
    return {
      ok: false,
      skipped: true,
      category: "disabled",
      error: "notifications disabled (dev)",
    };
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!key || !from) {
    return {
      ok: false,
      skipped: false,
      category: "not_configured",
      error: "RESEND_API_KEY / RESEND_FROM not set",
    };
  }

  // CL_NOTIFICATIONS_TEST_TO redirects only when it's an email; a phone number
  // there is meant for the SMS channel, so ignore it here and skip rather than
  // mail a real customer during testing.
  const testTo = process.env.CL_NOTIFICATIONS_TEST_TO?.trim();
  let to = opts.to;
  if (testTo) {
    if (!testTo.includes("@")) {
      return {
        ok: false,
        skipped: true,
        category: "test_mode",
        error: "CL_NOTIFICATIONS_TEST_TO is a phone number — email skipped in test mode",
      };
    }
    to = testTo;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }),
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j?.message || j?.error?.message || detail;
      } catch {
        /* keep raw */
      }
      return {
        ok: false,
        category: categorizeResendError(res.status, detail),
        error: `Resend ${res.status}: ${detail}`,
      };
    }

    let id: string | undefined;
    try {
      id = JSON.parse(text)?.id;
    } catch {
      /* ignore */
    }
    return { ok: true, providerMessageId: id };
  } catch (e) {
    const isTimeout = (e as Error).name === "AbortError";
    return {
      ok: false,
      category: "transient",
      error: (isTimeout ? "Resend request timed out" : (e as Error).message).slice(0, 300),
    };
  }
}
