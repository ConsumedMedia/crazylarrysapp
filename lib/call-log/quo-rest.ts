import { mapQuoEvent, type MappedEvent } from "./quo-events";

/**
 * Turns Quo REST objects (API 2026-03-30: GET /calls with
 * include=summary,voicemail, and GET /calls/{id}/transcripts) into the same
 * envelopes the webhook delivers, then runs them through mapQuoEvent. So the
 * backfill and the webhook share ONE mapper and ONE redaction path: nothing
 * here touches call text except to move it into place. Pure.
 *
 * REST differs from the webhook in three ways this file absorbs:
 *  - participants is [{phoneNumber, actorId}] instead of context.participants
 *    {external, resolution}. An entry without an actorId is the outside party.
 *  - transcript dialogue entries carry actorId; webhook entries carry userId.
 *  - summary and voicemail come inline on the call (include=...), with
 *    summary.status in place of processingStatus.
 */

export interface QuoRestParticipant {
  phoneNumber?: string | null;
  actorId?: string | null;
}

export interface QuoRestCall {
  id: string;
  phoneNumberId?: string | null;
  direction?: string | null;
  status?: string | null;
  participants?: QuoRestParticipant[] | null;
  createdAt?: string | null;
  completedAt?: string | null;
  duration?: number | null;
  summary?: { status?: string | null; summary?: string[] | null; nextSteps?: string[] | null } | null;
  voicemail?: { id?: string; status?: string | null; transcript?: string | null; duration?: number | null } | null;
}

export interface QuoRestDialogueEntry {
  content?: string | null;
  start?: number | null;
  end?: number | null;
  identifier?: string | null;
  actorId?: string | null;
}

export interface QuoRestTranscript {
  recordingId?: string | null;
  status?: string | null;
  startTime?: string | null;
  createdAt?: string | null;
  duration?: number | null;
  dialogue?: QuoRestDialogueEntry[] | null;
}

/** Quo call statuses after which nothing more happens to the call itself. */
export const FINAL_CALL_STATUSES = new Set([
  "completed",
  "answered",
  "missed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "forwarded",
  "abandoned",
]);

export function isFinalCall(call: QuoRestCall): boolean {
  return typeof call.status === "string" && FINAL_CALL_STATUSES.has(call.status);
}

function restContext(call: QuoRestCall, orgId: string) {
  const external = (call.participants ?? [])
    .filter((p) => !p.actorId && typeof p.phoneNumber === "string" && p.phoneNumber.trim() !== "")
    .map((p) => p.phoneNumber as string);
  return {
    orgId,
    phoneNumberId: call.phoneNumberId ?? null,
    participants: {
      workspace: [],
      external,
      resolution: external.length ? "available" : "unavailable",
    },
  };
}

const envelope = (type: string, resource: object, context: object) => ({
  id: null,
  apiVersion: "2026-03-30",
  type,
  data: { resource, context },
});

/** Webhook-shaped envelopes for one REST call: the call itself, then summary and voicemail when present. */
export function callEnvelopes(call: QuoRestCall, orgId: string): unknown[] {
  const ctx = restContext(call, orgId);
  const out: unknown[] = [
    envelope(
      "call.completed",
      {
        id: call.id,
        direction: call.direction,
        status: call.status,
        createdAt: call.createdAt,
        duration: call.duration,
        // include=voicemail is always requested; Quo omits the key when there is none.
        hasVoicemail: !!call.voicemail,
      },
      ctx,
    ),
  ];
  if (call.summary) {
    out.push(
      envelope(
        "call.summary.completed",
        {
          callId: call.id,
          processingStatus: call.summary.status,
          summary: call.summary.summary,
          nextSteps: call.summary.nextSteps,
        },
        ctx,
      ),
    );
  }
  if (call.voicemail && call.voicemail.status === "completed") {
    out.push(
      envelope(
        "call.voicemail.completed",
        {
          callId: call.id,
          direction: call.direction,
          transcript: call.voicemail.transcript,
          from: ctx.participants.external[0] ?? null,
        },
        ctx,
      ),
    );
  }
  return out;
}

/** Webhook-shaped envelope for one REST transcript (one recorded segment). */
export function transcriptEnvelope(call: QuoRestCall, t: QuoRestTranscript, orgId: string): unknown {
  return envelope(
    "call.transcript.completed",
    {
      callId: call.id,
      createdAt: t.createdAt,
      duration: t.duration,
      processingStatus: t.status,
      dialogue: Array.isArray(t.dialogue)
        ? t.dialogue.map((d) => ({
            userId: d.actorId ?? null,
            identifier: d.identifier ?? null,
            content: d.content,
            start: d.start,
            end: d.end,
          }))
        : null,
    },
    restContext(call, orgId),
  );
}

/** The mapped events for one REST call (no transcripts), through the webhook's mapper. */
export function mapRestCall(call: QuoRestCall, orgId: string): MappedEvent[] {
  return callEnvelopes(call, orgId).map((e) => mapQuoEvent(e));
}

/** The mapped event for one REST transcript, through the webhook's mapper. */
export function mapRestTranscript(call: QuoRestCall, t: QuoRestTranscript, orgId: string): MappedEvent {
  return mapQuoEvent(transcriptEnvelope(call, t, orgId));
}
