import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";

export interface CallTranscriptRow {
  id: string;
  quo_call_id: string | null;
  caller_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  duration_seconds: number | null;
  summary: string | null;
  transcript: string | null;
  received_at: string;
}

/**
 * Reads public.call_transcripts — scoped in Phase 1 for the Quo call-webhook
 * data, which isn't wired yet (see the call-transcripts-webhook open item), so
 * this will be empty until that's built. UI still needs to exist and handle
 * that cleanly.
 */
export async function listCallTranscripts(): Promise<CallTranscriptRow[]> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("call_transcripts")
    .select(
      "id, quo_call_id, caller_number, customer_id, duration_seconds, summary, transcript, received_at, customers(full_name)",
    )
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`listCallTranscripts: ${error.message}`);

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    quo_call_id: (r.quo_call_id as string | null) ?? null,
    caller_number: (r.caller_number as string | null) ?? null,
    customer_id: (r.customer_id as string | null) ?? null,
    customer_name: (r.customers as { full_name?: string } | null)?.full_name ?? null,
    duration_seconds: (r.duration_seconds as number | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    transcript: (r.transcript as string | null) ?? null,
    received_at: r.received_at as string,
  }));
}
