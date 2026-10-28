/**
 * Quo call-log settings. Env is read at call time (not module load) so tests
 * and a redeploy with new env both see current values.
 */

/**
 * How long transcript text (transcript, transcript_dialogue,
 * voicemail_transcript) is kept, counted from the call. The row itself —
 * time, number, duration, customer, summary — stays. Enforced by the stage-2
 * purge job; this is the one place the number lives.
 */
export const TRANSCRIPT_RETENTION_DAYS = 180;

/** Quo payloads are a few KB; anything this large is refused unread. */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

export interface QuoWebhookConfig {
  enabled: boolean;
  /** whsec_... signing secret of the registered Quo webhook. */
  key: string | null;
  /** Quo workspace id (OR...); events for any other workspace are dropped. */
  orgId: string | null;
}

export function readQuoWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): QuoWebhookConfig {
  return {
    enabled: env.CL_QUO_WEBHOOK_ENABLED === "1",
    key: env.QUO_WEBHOOK_KEY?.trim() || null,
    orgId: env.QUO_ORG_ID?.trim() || null,
  };
}
