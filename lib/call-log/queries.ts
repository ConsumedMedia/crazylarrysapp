import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";

export interface CallDialogueLine {
  speaker: "staff" | "caller";
  content: string;
  start: number | null;
}

export interface CallTranscriptRow {
  id: string;
  quo_call_id: string | null;
  caller_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  /** Set when several customers share the caller's number (none is linked). */
  matched_customers: Array<{ id: string; full_name: string }>;
  match_status: string | null;
  direction: string | null;
  call_status: string | null;
  call_started_at: string | null;
  has_voicemail: boolean | null;
  duration_seconds: number | null;
  summary: string | null;
  next_steps: string[];
  transcript: string | null;
  transcript_dialogue: CallDialogueLine[];
  voicemail_transcript: string | null;
  received_at: string;
}

/**
 * Reads public.call_transcripts, filled by the Quo webhook
 * (app/api/webhooks/quo). Staff only, here and in RLS. Needs migration
 * 20261028000000_quo_call_log for the new columns.
 */
export async function listCallTranscripts(): Promise<CallTranscriptRow[]> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("call_transcripts")
    .select(
      "id, quo_call_id, caller_number, customer_id, duration_seconds, summary, transcript, received_at, " +
        "direction, call_status, call_started_at, has_voicemail, next_steps, transcript_dialogue, " +
        "voicemail_transcript, matched_customer_ids, match_status, customers(full_name)",
    )
    .order("received_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`listCallTranscripts: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];

  // Names for calls whose number matched several customers.
  const multiIds = Array.from(
    new Set(
      rows
        .filter((r) => r.match_status === "multiple")
        .flatMap((r) => (r.matched_customer_ids as string[] | null) ?? []),
    ),
  );
  const names = new Map<string, string>();
  if (multiIds.length) {
    const { data: custs, error: custErr } = await supabase
      .from("customers")
      .select("id, full_name")
      .in("id", multiIds);
    if (custErr) throw new Error(`listCallTranscripts customers: ${custErr.message}`);
    for (const c of custs ?? []) names.set(c.id as string, c.full_name as string);
  }

  return rows.map((r) => ({
    id: r.id as string,
    quo_call_id: (r.quo_call_id as string | null) ?? null,
    caller_number: (r.caller_number as string | null) ?? null,
    customer_id: (r.customer_id as string | null) ?? null,
    customer_name: (r.customers as { full_name?: string } | null)?.full_name ?? null,
    matched_customers:
      r.match_status === "multiple"
        ? ((r.matched_customer_ids as string[] | null) ?? [])
            .filter((id) => names.has(id))
            .map((id) => ({ id, full_name: names.get(id) as string }))
        : [],
    match_status: (r.match_status as string | null) ?? null,
    direction: (r.direction as string | null) ?? null,
    call_status: (r.call_status as string | null) ?? null,
    call_started_at: (r.call_started_at as string | null) ?? null,
    has_voicemail: (r.has_voicemail as boolean | null) ?? null,
    duration_seconds: (r.duration_seconds as number | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    next_steps: (r.next_steps as string[] | null) ?? [],
    transcript: (r.transcript as string | null) ?? null,
    transcript_dialogue: (r.transcript_dialogue as CallDialogueLine[] | null) ?? [],
    voicemail_transcript: (r.voicemail_transcript as string | null) ?? null,
    received_at: r.received_at as string,
  }));
}
