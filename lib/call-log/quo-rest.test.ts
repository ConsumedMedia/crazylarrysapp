/**
 * Unit test: REST objects go through the webhook's own mapper and come out
 * with the same fields the webhook would store. All values are fictional.
 */
import { describe, it, expect } from "vitest";
import { mapQuoEvent } from "./quo-events";
import { mapRestCall, mapRestTranscript, isFinalCall, type QuoRestCall } from "./quo-rest";
import { REDACTED_CARD } from "./redact";
import {
  MIN_TRANSCRIPT_RETENTION_DAYS,
  QUO_BACKFILL_LOOKBACK_DAYS,
  QUO_YARD_PHONE_NUMBER_ID,
  TRANSCRIPT_RETENTION_DAYS,
  readCallLogStage2Flags,
  readQuoApiKey,
} from "./config";

const ORG = "ORtest123";
const CARD = "4111 1111 1111 1111";

const wh = (type: string, resource: object) =>
  mapQuoEvent({
    type,
    data: {
      resource,
      context: {
        orgId: ORG,
        phoneNumberId: "PNXYakN6nP",
        participants: { workspace: ["+16145550100"], external: ["+16145550142"], resolution: "available" },
      },
    },
  });

const REST_CALL: QuoRestCall = {
  id: "ACcall1",
  phoneNumberId: "PNXYakN6nP",
  direction: "incoming",
  status: "completed",
  participants: [
    { phoneNumber: "+16145550100", actorId: "USlarry" },
    { phoneNumber: "+16145550142", actorId: null },
  ],
  createdAt: "2026-11-09T14:00:00.000Z",
  completedAt: "2026-11-09T14:01:00.000Z",
  duration: 55,
  summary: { status: "completed", summary: ["Wants a 20 yard.", `Read ${CARD}.`], nextSteps: ["Call back"] },
};

describe("REST -> webhook mapper", () => {
  it("a call gives the same fields as the webhook's call.completed and summary events", () => {
    const [call, summary] = mapRestCall(REST_CALL, ORG);
    expect(call).toEqual(
      wh("call.completed", {
        id: "ACcall1",
        direction: "incoming",
        status: "completed",
        createdAt: "2026-11-09T14:00:00.000Z",
        duration: 55,
        hasVoicemail: false,
      }),
    );
    expect(summary).toEqual(
      wh("call.summary.completed", {
        callId: "ACcall1",
        processingStatus: "completed",
        summary: ["Wants a 20 yard.", `Read ${CARD}.`],
        nextSteps: ["Call back"],
      }),
    );
    if (summary.kind !== "ingest") throw new Error("expected ingest");
    expect(summary.fields.summary).toContain(REDACTED_CARD);
    expect(summary.fields.summary).not.toContain("4111");
  });

  it("the outside party is the participant without an actorId; none -> no caller number", () => {
    const [call] = mapRestCall(REST_CALL, ORG);
    if (call.kind !== "ingest") throw new Error("expected ingest");
    expect(call.fields.caller_number).toBe("+16145550142");
    const [noone] = mapRestCall({ ...REST_CALL, participants: [{ phoneNumber: "+16145550100", actorId: "USlarry" }] }, ORG);
    if (noone.kind !== "ingest") throw new Error("expected ingest");
    expect(noone.fields.caller_number).toBeUndefined();
  });

  it("a summary still processing stores nothing for the summary (the old one is kept)", () => {
    const [, s] = mapRestCall({ ...REST_CALL, summary: { status: "in-progress", summary: null, nextSteps: null } }, ORG);
    if (s.kind !== "ingest") throw new Error("expected ingest");
    expect(s.fields.summary).toBeUndefined();
    expect(s.fields.next_steps).toBeUndefined();
  });

  it("a missed call with a voicemail: status kept, voicemail redacted, caller from participants", () => {
    const events = mapRestCall(
      {
        ...REST_CALL,
        status: "missed",
        summary: null,
        voicemail: { id: "VM1", status: "completed", transcript: `Call me, or charge ${CARD}.`, duration: 12 },
      },
      ORG,
    );
    expect(events).toHaveLength(2);
    const [call, vm] = events;
    if (call.kind !== "ingest" || vm.kind !== "ingest") throw new Error("expected ingest");
    expect(call.fields.call_status).toBe("missed");
    expect(call.fields.has_voicemail).toBe(true);
    expect(vm.fields.voicemail_transcript).toBe(`Call me, or charge ${REDACTED_CARD}.`);
    expect(vm.fields.caller_number).toBe("+16145550142");
  });

  it("a voicemail still processing adds no voicemail event", () => {
    const events = mapRestCall({ ...REST_CALL, summary: null, voicemail: { status: "in-progress", transcript: null } }, ORG);
    expect(events).toHaveLength(1);
  });

  it("a transcript maps actorId to the staff speaker and redacts like the webhook does", () => {
    const rest = mapRestTranscript(
      REST_CALL,
      {
        recordingId: "CR1",
        status: "completed",
        startTime: "2026-11-09T14:00:01.000Z",
        createdAt: "2026-11-09T14:01:30.000Z",
        duration: 55,
        dialogue: [
          { actorId: "USlarry", identifier: "+16145550100", content: "Crazy Larry's", start: 0, end: 1.5 },
          { actorId: null, identifier: "+16145550142", content: `It's ${CARD}`, start: 2, end: 4 },
        ],
      },
      ORG,
    );
    const hook = wh("call.transcript.completed", {
      callId: "ACcall1",
      createdAt: "2026-11-09T14:01:30.000Z",
      duration: 55,
      processingStatus: "completed",
      dialogue: [
        { userId: "USlarry", identifier: "+16145550100", content: "Crazy Larry's", start: 0, end: 1.5 },
        { userId: null, identifier: "+16145550142", content: `It's ${CARD}`, start: 2, end: 4 },
      ],
    });
    expect(rest).toEqual(hook);
    if (rest.kind !== "ingest") throw new Error("expected ingest");
    expect(rest.fields.transcript).toBe(`Staff: Crazy Larry's\nCaller: It's ${REDACTED_CARD}`);
  });

  it("a transcript not yet completed stores no transcript", () => {
    const m = mapRestTranscript(REST_CALL, { status: "in-progress", dialogue: null }, ORG);
    if (m.kind !== "ingest") throw new Error("expected ingest");
    expect(m.fields.transcript).toBeUndefined();
  });

  it("only final statuses count as finished calls", () => {
    for (const s of ["completed", "answered", "missed", "no-answer", "abandoned"]) expect(isFinalCall({ id: "A", status: s })).toBe(true);
    for (const s of ["queued", "initiated", "ringing", "in-progress", null]) expect(isFinalCall({ id: "A", status: s })).toBe(false);
  });
});

describe("stage-2 config", () => {
  it("retention is at least the database's 30-day floor; the backfill window is shorter than retention", () => {
    expect(TRANSCRIPT_RETENTION_DAYS).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_RETENTION_DAYS);
    expect(MIN_TRANSCRIPT_RETENTION_DAYS).toBe(30);
    expect(QUO_BACKFILL_LOOKBACK_DAYS).toBeLessThan(TRANSCRIPT_RETENTION_DAYS);
  });

  it("the yard line id has Quo's PN shape", () => {
    expect(QUO_YARD_PHONE_NUMBER_ID).toMatch(/^PN[A-Za-z0-9]+$/);
  });

  it("each flag is on only when exactly '1'; all off by default", () => {
    expect(readCallLogStage2Flags({})).toEqual({ backfill: false, purge: false, segments: false });
    expect(
      readCallLogStage2Flags({
        CL_QUO_BACKFILL_ENABLED: "true",
        CL_CALL_TRANSCRIPT_PURGE_ENABLED: " 1",
        CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED: "yes",
      }),
    ).toEqual({ backfill: false, purge: false, segments: false });
    expect(readCallLogStage2Flags({ CL_CALL_TRANSCRIPT_PURGE_ENABLED: "1" })).toEqual({
      backfill: false,
      purge: true,
      segments: false,
    });
    expect(readCallLogStage2Flags({ CL_QUO_BACKFILL_ENABLED: "1", CL_QUO_TRANSCRIPT_SEGMENTS_ENABLED: "1" })).toEqual({
      backfill: true,
      purge: false,
      segments: true,
    });
  });

  it("a blank API key counts as missing", () => {
    expect(readQuoApiKey({})).toBeNull();
    expect(readQuoApiKey({ QUO_API_KEY: "   " })).toBeNull();
    expect(readQuoApiKey({ QUO_API_KEY: " k " })).toBe("k");
  });
});
