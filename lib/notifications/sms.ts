import "server-only";
import { toE164US } from "./phone";

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

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  skipped?: boolean;
}

export function smsEnabled(): boolean {
  return (
    process.env.CL_NOTIFICATIONS_ENABLED === "1" &&
    !!process.env.QUO_API_KEY &&
    !!process.env.QUO_FROM_NUMBER
  );
}

export async function sendSms(
  toE164: string,
  content: string,
): Promise<SendResult> {
  if (process.env.CL_NOTIFICATIONS_ENABLED !== "1") {
    return { ok: false, skipped: true, error: "notifications disabled (dev)" };
  }
  const key = process.env.QUO_API_KEY;
  if (!key || !process.env.QUO_FROM_NUMBER) {
    return { ok: false, skipped: true, error: "QUO_API_KEY / QUO_FROM_NUMBER not set" };
  }

  // Quo requires clean E.164 for both ends — normalize whatever's in the env.
  const from = toE164US(process.env.QUO_FROM_NUMBER);
  if (!from) {
    return {
      ok: false,
      error: `QUO_FROM_NUMBER is not a valid US number: "${process.env.QUO_FROM_NUMBER}" (want +1XXXXXXXXXX)`,
    };
  }

  let to = toE164;
  const testTo = process.env.CL_NOTIFICATIONS_TEST_TO?.trim();
  if (testTo) {
    if (testTo.includes("@")) {
      return {
        ok: false,
        skipped: true,
        error: "CL_NOTIFICATIONS_TEST_TO is an email address — SMS skipped in test mode",
      };
    }
    const t = toE164US(testTo);
    if (!t) {
      return {
        ok: false,
        error: `CL_NOTIFICATIONS_TEST_TO is not a valid US number: "${testTo}"`,
      };
    }
    to = t;
  }

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
      return { ok: false, error: `Quo ${res.status}: ${detail}` };
    }

    let id: string | undefined;
    try {
      const j = JSON.parse(text);
      id = j?.data?.id ?? j?.id;
    } catch {
      /* 202 with empty body is fine */
    }
    return { ok: true, providerMessageId: id };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "Quo request timed out" : (e as Error).message;
    return { ok: false, error: msg.slice(0, 300) };
  }
}
