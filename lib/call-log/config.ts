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

/**
 * The database refuses a purge shorter than this (purge_call_transcripts), so
 * a typo in TRANSCRIPT_RETENTION_DAYS can't wipe recent transcripts.
 */
export const MIN_TRANSCRIPT_RETENTION_DAYS = 30;

/** The yard's Quo line. The backfill reads calls on this number only. Not a secret. */
export const QUO_YARD_PHONE_NUMBER_ID = "PNXYakN6nP";

/**
 * How far back the daily backfill looks. Covers Quo's ~27.5 h of webhook
 * retries plus one missed cron run. Never reaches past retention.
 */
export const QUO_BACKFILL_LOOKBACK_DAYS = 3;

/** Calls newer than this are left for the next run, so Quo has finished processing them. */
export const QUO_BACKFILL_SETTLE_MINUTES = 30;

/**
 * Stage-2 switches. Each is on only when its variable is exactly "1".
 *   backfill  CL_QUO_BACKFILL_ENABLED             daily read of recent calls from Quo's API
 *   purge     CL_CALL_TRANSCRIPT_PURGE_ENABLED    daily removal of transcript text past retention
 *   segments  CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED  paused-call transcript segments merged, not replaced
 */
export interface CallLogStage2Flags {
  backfill: boolean;
  purge: boolean;
  segments: boolean;
}

export function readCallLogStage2Flags(
  env: Record<string, string | undefined> = process.env,
): CallLogStage2Flags {
  return {
    backfill: env.CL_QUO_BACKFILL_ENABLED === "1",
    purge: env.CL_CALL_TRANSCRIPT_PURGE_ENABLED === "1",
    segments: env.CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED === "1",
  };
}

/** The Quo API key (the same one SMS uses). Never logged. */
export function readQuoApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env.QUO_API_KEY?.trim() || null;
}

/** Quo payloads are a few KB; anything this large is refused unread. */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

export interface QuoWebhookConfig {
  enabled: boolean;
  /** whsec_... signing secret of the registered Quo webhook. */
  key: string | null;
  /** Quo workspace id (OR...); events for any other workspace are dropped. */
  orgId: string | null;
  /**
   * CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED=1: a transcript is sent as one segment
   * (merged with the call's other segments by the database, migration
   * 20261110010000) instead of replacing the stored transcript.
   */
  segments?: boolean;
}

export function readQuoWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): QuoWebhookConfig {
  return {
    enabled: env.CL_QUO_WEBHOOK_ENABLED === "1",
    key: env.QUO_WEBHOOK_KEY?.trim() || null,
    orgId: env.QUO_ORG_ID?.trim() || null,
    segments: readCallLogStage2Flags(env).segments,
  };
}
