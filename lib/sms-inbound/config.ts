import { QUO_YARD_PHONE_NUMBER_ID } from "@/lib/call-log/config";

/**
 * Quo SMS webhook settings (Plan B.4). A separate Quo subscription from the
 * call webhook, with its own signing key, so the call log can stay off while
 * STOP handling runs. Env is read at call time.
 *
 *   CL_QUO_SMS_WEBHOOK_ENABLED=1   turns the route on (anything else: 503)
 *   QUO_SMS_WEBHOOK_KEY            whsec_... key of the message.received subscription
 *   QUO_ORG_ID                     Larry's Quo workspace (shared with the call webhook)
 */
export interface QuoSmsWebhookConfig {
  enabled: boolean;
  key: string | null;
  orgId: string | null;
  /** Only texts to this line count (the yard line). */
  yardPhoneNumberId: string;
}

export function readQuoSmsWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): QuoSmsWebhookConfig {
  return {
    enabled: env.CL_QUO_SMS_WEBHOOK_ENABLED === "1",
    key: env.QUO_SMS_WEBHOOK_KEY?.trim() || null,
    orgId: env.QUO_ORG_ID?.trim() || null,
    yardPhoneNumberId: QUO_YARD_PHONE_NUMBER_ID,
  };
}

/** Stored review text is capped at this (the database refuses more). */
export const REVIEW_TEXT_MAX = 500;
