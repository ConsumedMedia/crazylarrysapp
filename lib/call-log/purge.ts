import { TRANSCRIPT_RETENTION_DAYS, readCallLogStage2Flags } from "./config";

/**
 * Daily transcript purge (stage 2A). Off unless
 * CL_CALL_TRANSCRIPT_PURGE_ENABLED=1. Needs no Quo key: it only calls
 * public.purge_call_transcripts(TRANSCRIPT_RETENTION_DAYS) with the service
 * client. Migration 20261110000000 must be applied before the flag is turned on.
 *
 * Never throws. A database error comes back as ok:false with the error code
 * only (no message text), so the daily cron reports it and runs its other jobs.
 */

export type PurgeRpc = (
  name: "purge_call_transcripts",
  args: { p_days: number },
) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

export interface PurgeResult {
  ok: boolean;
  enabled: boolean;
  retention_days: number;
  purged: number;
  error?: string;
}

export async function runTranscriptPurge(
  rpc: PurgeRpc,
  env: Record<string, string | undefined> = process.env,
): Promise<PurgeResult> {
  const out: PurgeResult = { ok: true, enabled: false, retention_days: TRANSCRIPT_RETENTION_DAYS, purged: 0 };
  if (!readCallLogStage2Flags(env).purge) return out;
  out.enabled = true;
  try {
    const { data, error } = await rpc("purge_call_transcripts", { p_days: TRANSCRIPT_RETENTION_DAYS });
    if (error) return { ...out, ok: false, error: `purge_failed ${error.code ?? "unknown"}` };
    if (typeof data !== "number" || !Number.isInteger(data) || data < 0) {
      return { ...out, ok: false, error: "purge_bad_result" };
    }
    return { ...out, purged: data };
  } catch {
    return { ...out, ok: false, error: "purge_failed network" };
  }
}
