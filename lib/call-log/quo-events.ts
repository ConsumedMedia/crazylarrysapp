import { redactCardNumbers } from "./redact";

/**
 * Maps a verified Quo webhook envelope (API version 2026-03-30) to the
 * arguments of public.ingest_quo_call_event. Pure.
 *
 * Every piece of free text leaves here already redacted: summary lines, next
 * steps, each transcript line (and the plain-text transcript built from
 * them), and the voicemail transcript. Fields an event doesn't carry are left
 * out, so the RPC keeps what an earlier event stored.
 */

export const HANDLED_EVENT_TYPES = [
  "call.completed",
  "call.missed",
  "call.summary.completed",
  "call.transcript.completed",
  "call.voicemail.completed",
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export interface DialogueLine {
  speaker: "staff" | "caller";
  content: string;
  start: number | null;
}

/** Keys match p_event in the migration. Absent = this event doesn't carry it. */
export interface IngestFields {
  caller_number?: string;
  direction?: "incoming" | "outgoing";
  call_status?: string;
  call_started_at?: string;
  duration_seconds?: number;
  has_voicemail?: boolean;
  quo_phone_number_id?: string;
  summary?: string;
  next_steps?: string[];
  transcript?: string;
  transcript_dialogue?: DialogueLine[];
  voicemail_transcript?: string;
}

export type MappedEvent =
  | { kind: "ingest"; type: HandledEventType; callId: string; orgId: string | null; fields: IngestFields }
  | { kind: "ignore"; type: string | null; orgId: string | null; reason: "unhandled_type" | "no_call_id" | "malformed" };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
const direction = (v: unknown) => (v === "incoming" || v === "outgoing" ? v : undefined);
const textList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

function contextFields(context: Obj | undefined): IngestFields {
  const out: IngestFields = {};
  const participants = isObj(context?.participants) ? context.participants : undefined;
  // Empty arrays with resolution "unavailable" mean unknown, not "no caller".
  if (participants && participants.resolution === "available" && Array.isArray(participants.external)) {
    const caller = str(participants.external[0]);
    if (caller) out.caller_number = caller;
  }
  const pn = str(context?.phoneNumberId);
  if (pn) out.quo_phone_number_id = pn;
  return out;
}

export function mapQuoEvent(envelope: unknown): MappedEvent {
  if (!isObj(envelope) || !isObj(envelope.data)) {
    return { kind: "ignore", type: null, orgId: null, reason: "malformed" };
  }
  const type = str(envelope.type) ?? null;
  const data = envelope.data;
  const context = isObj(data.context) ? data.context : undefined;
  const orgId = str(context?.orgId) ?? null;
  const resource = isObj(data.resource) ? data.resource : undefined;

  if (!type || !(HANDLED_EVENT_TYPES as readonly string[]).includes(type)) {
    return { kind: "ignore", type, orgId, reason: "unhandled_type" };
  }
  if (!resource) return { kind: "ignore", type, orgId, reason: "malformed" };

  const t = type as HandledEventType;
  // Lifecycle events key on resource.id; artifacts (summary, transcript,
  // voicemail) key on resource.callId.
  const callId = t === "call.completed" || t === "call.missed" ? str(resource.id) : str(resource.callId);
  if (!callId) return { kind: "ignore", type, orgId, reason: "no_call_id" };

  const fields: IngestFields = contextFields(context);

  switch (t) {
    case "call.completed": {
      const dir = direction(resource.direction);
      if (dir) fields.direction = dir;
      const status = str(resource.status);
      if (status) fields.call_status = status;
      const started = str(resource.createdAt);
      if (started) fields.call_started_at = started;
      const dur = num(resource.duration);
      if (dur !== undefined) fields.duration_seconds = dur;
      if (typeof resource.hasVoicemail === "boolean") fields.has_voicemail = resource.hasVoicemail;
      break;
    }
    case "call.missed": {
      fields.direction = "incoming"; // Quo fires call.missed for incoming calls only
      fields.call_status = "missed";
      const started = str(resource.createdAt);
      if (started) fields.call_started_at = started;
      break;
    }
    case "call.summary.completed": {
      // Only a completed summary is stored; anything else leaves the old one.
      if (resource.processingStatus === "completed") {
        const lines = textList(resource.summary).map(redactCardNumbers);
        if (lines.length) fields.summary = lines.join("\n");
        const steps = textList(resource.nextSteps).map(redactCardNumbers);
        if (steps.length) fields.next_steps = steps;
      }
      break;
    }
    case "call.transcript.completed": {
      if (resource.processingStatus === "completed" && Array.isArray(resource.dialogue)) {
        const dialogue: DialogueLine[] = resource.dialogue
          .filter(isObj)
          .filter((d) => typeof d.content === "string" && d.content.trim() !== "")
          .map((d) => ({
            // A Quo userId means a workspace member; external parties only
            // have an identifier (their number), which we don't keep per line.
            speaker: str(d.userId) ? "staff" : "caller",
            content: redactCardNumbers(d.content as string),
            start: num(d.start) ?? null,
          }));
        if (dialogue.length) {
          fields.transcript_dialogue = dialogue;
          fields.transcript = dialogue
            .map((d) => `${d.speaker === "staff" ? "Staff" : "Caller"}: ${d.content}`)
            .join("\n");
        }
      }
      break;
    }
    case "call.voicemail.completed": {
      fields.has_voicemail = true;
      const dir = direction(resource.direction);
      if (dir) fields.direction = dir;
      const vm = str(resource.transcript);
      if (vm) fields.voicemail_transcript = redactCardNumbers(vm);
      if (!fields.caller_number && dir === "incoming") {
        const from = str(resource.from);
        if (from) fields.caller_number = from;
      }
      break;
    }
  }

  return { kind: "ingest", type: t, callId, orgId, fields };
}
