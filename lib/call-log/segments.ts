import { createHash } from "node:crypto";
import type { DialogueLine } from "./quo-events";
import { redactCardNumbers } from "./redact";

/**
 * Paused-call transcript segments. Quo makes one recording per recorded
 * stretch of a call, and one transcript per recording, so a paused and resumed
 * call has several. Pure helpers; nothing here is wired in yet (stage 2,
 * behind CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED, after migration B).
 *
 * - A segment's key is a hash of its redacted line text only. The same
 *   segment from a retried webhook, or from the webhook and from the REST
 *   backfill, gets the same key, so it is stored once.
 * - Segments are ordered by order_at (REST startTime, else the webhook's
 *   createdAt), then by key so the order is stable.
 * - Between segments the merge puts a divider line. A divider has speaker
 *   "divider": never staff, caller or unknown, so it can't be read as
 *   something somebody said. In plain text it has no "Staff:"/"Caller:" prefix.
 * - Redaction covers the merged output: every line is redacted again, and so
 *   is the merged plain text, even though segments are redacted on the way in.
 *   A card number read across two lines is still not caught (known limit,
 *   lib/call-log/redact.ts).
 */

export const SEGMENT_DIVIDER_TEXT = "Call resumed";

export interface DividerLine {
  speaker: "divider";
  content: string;
  start: null;
  end: null;
  user_id: null;
  has_identifier: false;
}

export type MergedLine = DialogueLine | DividerLine;

export interface TranscriptSegment {
  key: string;
  /** ISO time used to order segments: REST startTime, else webhook createdAt. */
  order_at: string | null;
  recording_id: string | null;
  duration: number | null;
  lines: DialogueLine[];
}

const speakerLabel = { staff: "Staff", caller: "Caller", unknown: "Unknown" } as const;

/** Stable key for a segment: sha256 over the redacted line text, nothing else. */
export function segmentKey(lines: DialogueLine[]): string {
  const text = lines.map((l) => redactCardNumbers(l.content)).join("\n");
  return "seg_" + createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

export function makeSegment(
  lines: DialogueLine[],
  meta: { order_at?: string | null; recording_id?: string | null; duration?: number | null } = {},
): TranscriptSegment {
  const redacted = lines.map((l) => ({ ...l, content: redactCardNumbers(l.content) }));
  return {
    key: segmentKey(redacted),
    order_at: meta.order_at ?? null,
    recording_id: meta.recording_id ?? null,
    duration: meta.duration ?? null,
    lines: redacted,
  };
}

const divider = (): DividerLine => ({
  speaker: "divider",
  content: SEGMENT_DIVIDER_TEXT,
  start: null,
  end: null,
  user_id: null,
  has_identifier: false,
});

function orderValue(s: TranscriptSegment): number {
  const t = s.order_at ? Date.parse(s.order_at) : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export function sortSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const byKey = new Map<string, TranscriptSegment>();
  for (const s of segments) if (!byKey.has(s.key)) byKey.set(s.key, s);
  return Array.from(byKey.values()).sort(
    (a, b) => orderValue(a) - orderValue(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** Ordered, de-duplicated, divider-separated dialogue plus its plain text. Both redacted. */
export function mergeSegments(segments: TranscriptSegment[]): { dialogue: MergedLine[]; transcript: string } {
  const dialogue: MergedLine[] = [];
  sortSegments(segments).forEach((s, i) => {
    if (s.lines.length === 0) return;
    if (i > 0 && dialogue.length > 0) dialogue.push(divider());
    for (const l of s.lines) dialogue.push({ ...l, content: redactCardNumbers(l.content) });
  });
  const text = dialogue
    .map((d) => (d.speaker === "divider" ? `— ${d.content} —` : `${speakerLabel[d.speaker]}: ${d.content}`))
    .join("\n");
  return { dialogue, transcript: redactCardNumbers(text) };
}
