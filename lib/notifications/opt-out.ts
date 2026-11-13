import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Whether a number may be texted (Plan B.4). Every SMS asks this first,
 * customers and drivers alike, through public.sms_block_status (service role):
 *
 *   'opted_out'       the number replied STOP (and no newer START)
 *   'pending_review'  an opt-out word inside a longer message, not yet
 *                     resolved by staff: blocked until they do
 *   null              not blocked
 *
 * An unreadable list blocks the text (ok:false; the caller sends nothing).
 * The one exception is the function not existing yet (code deployed before
 * migration 20261113000000): then nothing can have opted out through it, so
 * the text goes as before, with a warning.
 */

export type SmsBlock = "opted_out" | "pending_review" | null;
export type SmsBlockCheck = { ok: true; block: SmsBlock } | { ok: false; error: string };

function functionMissing(error: { code?: string; message?: string }): boolean {
  return (error.code === "PGRST202" || error.code === "42883") && (error.message ?? "").includes("sms_block_status");
}

export async function smsBlockStatus(phone: string): Promise<SmsBlockCheck> {
  try {
    const { data, error } = await createServiceClient().rpc("sms_block_status", { p_phone: phone });
    if (error) {
      if (functionMissing(error)) {
        console.warn("[notify] sms_block_status not found (migration 20261113000000 not applied); texting as before");
        return { ok: true, block: null };
      }
      return { ok: false, error: `sms_block_status ${error.code ?? "unknown"}` };
    }
    if (data === null || data === "opted_out" || data === "pending_review") return { ok: true, block: data };
    return { ok: false, error: "sms_block_status bad_result" };
  } catch {
    return { ok: false, error: "sms_block_status network" };
  }
}
