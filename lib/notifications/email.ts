import "server-only";
import type { FailureCategory, SendResult } from "./sms";
import { isReservedEmail } from "./reserved";
import { resolveTestRedirect } from "./test-mode";

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

  // A reserved fictional address is never sent to, redirected or not, so test
  // mode behaves the way production will once the test variables are cleared.
  if (isReservedEmail(opts.to)) {
    return {
      ok: false,
      skipped: true,
      category: "recipient_missing",
      error: "reserved test address (example.com/.net/.org) — not sent",
    };
  }

  // Test mode (any of CL_NOTIFICATIONS_TEST_PHONE / _EMAIL / _TO set): only the
  // test address, never the customer. See test-mode.ts for the rules.
  const redirect = resolveTestRedirect("email");
  if (redirect.mode === "skip") {
    return {
      ok: false,
      skipped: redirect.category === "test_mode",
      category: redirect.category,
      error: redirect.reason,
    };
  }
  const to = redirect.mode === "redirect" ? redirect.to : opts.to;
  const delivery = {
    sentTo: to,
    redirected: redirect.mode === "redirect",
    ...(redirect.mode === "redirect" ? { redirectedVia: redirect.via } : {}),
  };

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
        ...delivery,
      };
    }

    let id: string | undefined;
    try {
      id = JSON.parse(text)?.id;
    } catch {
      /* ignore */
    }
    return { ok: true, providerMessageId: id, ...delivery };
  } catch (e) {
    const isTimeout = (e as Error).name === "AbortError";
    return {
      ok: false,
      category: "transient",
      error: (isTimeout ? "Resend request timed out" : (e as Error).message).slice(0, 300),
      ...delivery,
    };
  }
}
