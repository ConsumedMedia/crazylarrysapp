import {
  QUO_BACKFILL_LOOKBACK_DAYS,
  QUO_BACKFILL_SETTLE_MINUTES,
  QUO_YARD_PHONE_NUMBER_ID,
  TRANSCRIPT_RETENTION_DAYS,
  readCallLogStage2Flags,
  readQuoApiKey,
} from "./config";
import { QuoApiError, type QuoClient } from "./quo-api";
import type { IngestFields, TranscriptSegmentInput } from "./quo-events";
import { isFinalCall, mapRestCall, mapRestTranscript, type QuoRestCall, type QuoRestTranscript } from "./quo-rest";
import { yardToday } from "@/lib/time/yard";

/**
 * Daily Quo backfill (stage 2). Off unless CL_QUO_BACKFILL_ENABLED is exactly
 * "1"; needs QUO_API_KEY. Reads recent calls on the yard line from Quo's REST
 * API and fills in what the webhook missed. Read-only towards Quo.
 *
 * Window: from the later of (now − 3 days) and (now − (retention − 1) days),
 * so it never reaches a call the purge may already have emptied, to now − 30
 * minutes, so Quo has finished processing. Calls whose status isn't final are
 * skipped.
 *
 * Per page of calls (GET /calls, newest first, 50 at a time, following
 * nextCursor): one select reads the existing rows. A call is written only when
 * something is missing — no row, no status, a summary or voicemail transcript
 * Quo has and the row doesn't, or a transcript the row hasn't got from REST
 * yet (no segments, or segments the webhook made, which carry no recording
 * id). Its transcripts (GET /calls/{id}/transcripts) are fetched only then,
 * and never for a purged row or a call that can't have a recording.
 *
 * Everything goes through quo-rest.ts and the webhook's own mapper, so
 * redaction runs in one place, then ONE ingest_quo_call_event call per call
 * with p_source 'backfill' (fill-only: never overwrites what the webhook
 * stored). A complete REST transcript set is sent as transcript_segments, so
 * the database replaces the call's segments with it. A set is sent only when
 * no transcript is still in progress.
 *
 * Interruption: all of a call's data is fetched before its single write, and
 * one write is one database transaction. A run cut off at any point (a cap, an
 * error, or Vercel ending the function) leaves every call either fully
 * written or untouched; the next run picks up the rest.
 *
 * Caps per run: 100 calls written, 300 Quo requests (retries count), 60
 * seconds. The client spaces requests 200 ms apart (5 a second) and backs off
 * on 429. Hitting a cap stops cleanly with ok:true and says what was left.
 * Any other Quo or database error stops the run with ok:false.
 *
 * The result carries counts and error codes only: never phone numbers, call
 * text or the key. Nothing here logs.
 */

export const BACKFILL_MAX_CALLS = 100;
export const BACKFILL_MAX_REQUESTS = 300;
export const BACKFILL_MAX_MS = 60_000;
export const BACKFILL_PAGE_LIMIT = 50;
/** mapQuoEvent wants a workspace id; REST data is ours by construction (our key), so any marker will do. */
const REST_ORG = "rest";
const DAY_MS = 86_400_000;

/** What the backfill needs to know about a stored row. No text. */
export interface ExistingCallRow {
  has_status: boolean;
  has_summary: boolean;
  has_voicemail_transcript: boolean;
  has_transcript: boolean;
  segment_count: number;
  /** Segments that came from a REST set (they carry a recording id). */
  rest_segment_count: number;
  purged: boolean;
}

/** Columns readRows selects; reduced to ExistingCallRow at once (the text is never kept or logged). */
export const EXISTING_ROW_COLUMNS =
  "quo_call_id, call_status, summary, voicemail_transcript, transcript, transcript_segments, transcript_purged_at";

export function existingRowsFrom(rows: Array<Record<string, unknown>>): Map<string, ExistingCallRow> {
  const out = new Map<string, ExistingCallRow>();
  for (const r of rows) {
    if (typeof r.quo_call_id !== "string") continue;
    const segs = Array.isArray(r.transcript_segments) ? (r.transcript_segments as Array<Record<string, unknown>>) : [];
    out.set(r.quo_call_id, {
      has_status: r.call_status != null,
      has_summary: r.summary != null && r.summary !== "",
      has_voicemail_transcript: r.voicemail_transcript != null && r.voicemail_transcript !== "",
      has_transcript: r.transcript != null && r.transcript !== "",
      segment_count: segs.length,
      rest_segment_count: segs.filter((s) => typeof s?.recording_id === "string" && s.recording_id !== "").length,
      purged: r.transcript_purged_at != null,
    });
  }
  return out;
}

export interface BackfillEvent extends IngestFields {
  transcript_segments?: TranscriptSegmentInput[];
}

export interface BackfillDeps {
  client: Pick<QuoClient, "getPage" | "requests">;
  /** One select for a page of call ids. Throws BackfillDbError on failure. */
  readRows(callIds: string[]): Promise<Map<string, ExistingCallRow>>;
  /** ingest_quo_call_event(callId, runId, event, 'backfill'). Throws BackfillDbError on failure. */
  ingest(callId: string, runId: string, event: BackfillEvent): Promise<void>;
  now(): number;
}

export class BackfillDbError extends Error {
  constructor(readonly code: string) {
    super(`db ${code}`);
    this.name = "BackfillDbError";
  }
}

export type BackfillStop = "done" | "call_cap" | "request_cap" | "time_cap" | "error";

export interface BackfillResult {
  ok: boolean;
  enabled: boolean;
  error?: string;
  missing?: string[];
  run_id?: string;
  window?: { from: string; to: string };
  stopped?: BackfillStop;
  calls_seen: number;
  written: number;
  already_complete: number;
  skipped_not_final: number;
  skipped_purged: number;
  transcripts_fetched: number;
  transcripts_pending: number;
  requests: number;
  /** What a stopped run didn't reach: calls left in the page it stopped on, and whether more pages exist. */
  left?: { calls_in_page: number; more_pages: boolean };
}

const emptyResult = (enabled: boolean): BackfillResult => ({
  ok: true,
  enabled,
  calls_seen: 0,
  written: 0,
  already_complete: 0,
  skipped_not_final: 0,
  skipped_purged: 0,
  transcripts_fetched: 0,
  transcripts_pending: 0,
  requests: 0,
});

export function backfillWindow(nowMs: number): { from: string; to: string } {
  const from = Math.max(nowMs - QUO_BACKFILL_LOOKBACK_DAYS * DAY_MS, nowMs - (TRANSCRIPT_RETENTION_DAYS - 1) * DAY_MS);
  const to = nowMs - QUO_BACKFILL_SETTLE_MINUTES * 60_000;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Statuses that never have a recording, so never a transcript. */
const NO_RECORDING = new Set(["missed", "no-answer", "busy", "failed", "canceled", "abandoned"]);

export function mayHaveTranscript(call: QuoRestCall): boolean {
  return !NO_RECORDING.has(call.status ?? "") && typeof call.duration === "number" && call.duration > 0;
}

export function needsTranscript(call: QuoRestCall, row: ExistingCallRow | undefined): boolean {
  if (!mayHaveTranscript(call)) return false;
  if (!row) return true;
  return row.segment_count === 0 || row.rest_segment_count < row.segment_count;
}

export function needsWork(call: QuoRestCall, row: ExistingCallRow | undefined): boolean {
  if (!row) return true;
  if (row.purged) return false;
  if (!row.has_status) return true;
  if (call.summary?.status === "completed" && (call.summary.summary?.length ?? 0) > 0 && !row.has_summary) return true;
  if (call.voicemail?.status === "completed" && call.voicemail.transcript && !row.has_voicemail_transcript) return true;
  return needsTranscript(call, row);
}

/** The call's own fields (call, summary, voicemail), through the webhook's mapper. */
export function callFields(call: QuoRestCall): BackfillEvent {
  const fields: BackfillEvent = {};
  for (const m of mapRestCall(call, REST_ORG)) if (m.kind === "ingest") Object.assign(fields, m.fields);
  return fields;
}

/** A complete REST set as segments, through the webhook's mapper; null while any transcript is in progress. */
export function transcriptSet(call: QuoRestCall, transcripts: QuoRestTranscript[]): TranscriptSegmentInput[] | null {
  if (transcripts.some((t) => t.status === "in-progress")) return null;
  const set: TranscriptSegmentInput[] = [];
  for (const t of transcripts) {
    if (t.status !== "completed") continue;
    const m = mapRestTranscript(call, t, REST_ORG);
    const lines = m.kind === "ingest" ? m.fields.transcript_dialogue : undefined;
    if (!lines?.length) continue;
    set.push({
      lines,
      order_at: t.startTime ?? t.createdAt ?? null,
      recording_id: t.recordingId ?? null,
      duration: typeof t.duration === "number" ? t.duration : null,
    });
  }
  return set;
}

class CapReached extends Error {
  constructor(readonly reason: "time_cap") {
    super(reason);
  }
}

/** One backfill run with the given dependencies. Never throws. */
export async function backfillOnce(deps: BackfillDeps): Promise<BackfillResult> {
  const out = emptyResult(true);
  const started = deps.now();
  out.run_id = `backfill:${yardToday(new Date(started))}`;
  out.window = backfillWindow(started);
  const timeLeft = () => {
    if (deps.now() - started >= BACKFILL_MAX_MS) throw new CapReached("time_cap");
  };

  let cursor: string | undefined;
  let pageLeft = 0;
  let morePages = false;
  try {
    for (;;) {
      timeLeft();
      const page = await deps.client.getPage<QuoRestCall>("/calls", {
        phoneNumberId: QUO_YARD_PHONE_NUMBER_ID,
        "createdAt[gte]": out.window.from,
        "createdAt[lte]": out.window.to,
        include: "summary,voicemail",
        limit: String(BACKFILL_PAGE_LIMIT),
        after: cursor,
      });
      morePages = page.nextCursor !== null;
      const calls = page.data.filter((c): c is QuoRestCall => !!c && typeof c.id === "string" && c.id !== "");
      pageLeft = calls.length;
      out.calls_seen += calls.length;

      const finalCalls = calls.filter(isFinalCall);
      const rows = finalCalls.length ? await deps.readRows(finalCalls.map((c) => c.id)) : new Map<string, ExistingCallRow>();

      for (const call of calls) {
        if (!isFinalCall(call)) {
          out.skipped_not_final++;
          pageLeft--;
          continue;
        }
        const row = rows.get(call.id);
        if (row?.purged) {
          out.skipped_purged++;
          pageLeft--;
          continue;
        }
        if (!needsWork(call, row)) {
          out.already_complete++;
          pageLeft--;
          continue;
        }
        if (out.written >= BACKFILL_MAX_CALLS) {
          out.stopped = "call_cap";
          out.left = { calls_in_page: pageLeft, more_pages: morePages };
          return finish(out, deps);
        }

        // Gather everything for this call first; write once.
        const event = callFields(call);
        if (needsTranscript(call, row)) {
          const transcripts: QuoRestTranscript[] = [];
          let tCursor: string | undefined;
          do {
            timeLeft();
            const tp = await deps.client.getPage<QuoRestTranscript>(`/calls/${encodeURIComponent(call.id)}/transcripts`, {
              limit: String(BACKFILL_PAGE_LIMIT),
              after: tCursor,
            });
            transcripts.push(...tp.data.filter((t) => !!t && typeof t === "object"));
            tCursor = tp.nextCursor ?? undefined;
          } while (tCursor);
          out.transcripts_fetched++;
          const set = transcriptSet(call, transcripts);
          if (set === null) out.transcripts_pending++;
          else if (set.length) event.transcript_segments = set;
        }
        timeLeft();
        await deps.ingest(call.id, out.run_id, event);
        out.written++;
        pageLeft--;
      }

      if (!page.nextCursor) {
        out.stopped = "done";
        return finish(out, deps);
      }
      cursor = page.nextCursor;
      pageLeft = 0;
    }
  } catch (e) {
    if (e instanceof CapReached || (e instanceof QuoApiError && e.kind === "request_cap")) {
      out.stopped = e instanceof CapReached ? e.reason : "request_cap";
      out.left = { calls_in_page: pageLeft, more_pages: morePages };
      return finish(out, deps);
    }
    out.ok = false;
    out.stopped = "error";
    out.left = { calls_in_page: pageLeft, more_pages: morePages };
    out.error =
      e instanceof QuoApiError
        ? `quo_${e.kind}${e.status !== null ? `_${e.status}` : ""}`
        : e instanceof BackfillDbError
          ? `db_${e.code}`
          : "unexpected";
    return finish(out, deps);
  }
}

function finish(out: BackfillResult, deps: BackfillDeps): BackfillResult {
  out.requests = deps.client.requests;
  return out;
}

/**
 * The cron step: flag, then configuration, then one run. `makeDeps` is called
 * only when the flag is on and the key is present, so a missing key means no
 * client, no request and no write.
 */
export async function runBackfill(
  makeDeps: (key: string) => BackfillDeps,
  env: Record<string, string | undefined> = process.env,
): Promise<BackfillResult> {
  if (!readCallLogStage2Flags(env).backfill) return emptyResult(false);
  const missing: string[] = [];
  const key = readQuoApiKey(env);
  if (!key) missing.push("QUO_API_KEY");
  if (!/^PN[A-Za-z0-9]+$/.test(QUO_YARD_PHONE_NUMBER_ID)) missing.push("QUO_YARD_PHONE_NUMBER_ID");
  if (!key || missing.length) return { ...emptyResult(true), ok: false, error: "not_configured", missing };
  try {
    return await backfillOnce(makeDeps(key));
  } catch {
    return { ...emptyResult(true), ok: false, error: "unexpected" };
  }
}
