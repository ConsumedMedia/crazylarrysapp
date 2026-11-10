/**
 * Unit test for paused-call segment merging. Pure; fictional values.
 */
import { describe, it, expect } from "vitest";
import type { DialogueLine } from "./quo-events";
import { REDACTED_CARD } from "./redact";
import { makeSegment, mergeSegments, segmentKey, sortSegments, SEGMENT_DIVIDER_TEXT, type TranscriptSegment } from "./segments";

const CARD = "4111 1111 1111 1111";
const line = (speaker: DialogueLine["speaker"], content: string, start = 0): DialogueLine => ({
  speaker,
  content,
  start,
  end: start + 1,
  user_id: speaker === "staff" ? "USlarry" : null,
  has_identifier: speaker !== "unknown",
});

const first = makeSegment([line("staff", "Crazy Larry's"), line("caller", "Need a 20 yard", 2)], {
  order_at: "2026-11-09T14:00:00.000Z",
});
const second = makeSegment([line("caller", "Back again", 0), line("staff", "Go ahead", 1)], {
  order_at: "2026-11-09T14:05:00.000Z",
});

describe("segment keys", () => {
  it("same text -> same key, whatever the timing, source or recording id", () => {
    const a = makeSegment([line("caller", "Hello", 0)], { order_at: "2026-11-09T14:00:00Z", recording_id: "CR1" });
    const b = makeSegment([{ ...line("caller", "Hello", 9), end: 99 }], { order_at: "2026-11-09T14:01:00Z" });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(makeSegment([line("caller", "Hello!")]).key);
  });

  it("the key is built from redacted text, so a raw and a redacted copy match", () => {
    expect(segmentKey([line("caller", `It's ${CARD}`)])).toBe(segmentKey([line("caller", `It's ${REDACTED_CARD}`)]));
  });
});

describe("mergeSegments", () => {
  it("orders by order_at, not by arrival", () => {
    const { dialogue } = mergeSegments([second, first]);
    expect(dialogue.map((d) => d.content)).toEqual([
      "Crazy Larry's",
      "Need a 20 yard",
      SEGMENT_DIVIDER_TEXT,
      "Back again",
      "Go ahead",
    ]);
  });

  it("a retried segment (same key) appears once", () => {
    const { dialogue } = mergeSegments([first, second, first, second]);
    expect(dialogue.filter((d) => d.speaker === "divider")).toHaveLength(1);
    expect(dialogue).toHaveLength(5);
  });

  it("the divider carries no staff, caller or unknown speaker, no user id and no identifier", () => {
    const { dialogue, transcript } = mergeSegments([first, second]);
    const d = dialogue[2];
    expect(d.speaker).toBe("divider");
    expect(["staff", "caller", "unknown"]).not.toContain(d.speaker);
    expect(d.user_id).toBeNull();
    expect(d.has_identifier).toBe(false);
    expect(d.start).toBeNull();
    const dividerText = transcript.split("\n")[2];
    expect(dividerText).toBe(`— ${SEGMENT_DIVIDER_TEXT} —`);
    expect(dividerText).not.toMatch(/^(Staff|Caller|Unknown):/);
  });

  it("one segment: no divider", () => {
    const { dialogue, transcript } = mergeSegments([first]);
    expect(dialogue.some((d) => d.speaker === "divider")).toBe(false);
    expect(transcript).toBe("Staff: Crazy Larry's\nCaller: Need a 20 yard");
  });

  it("an empty segment adds no divider of its own", () => {
    const empty: TranscriptSegment = { key: "seg_empty", order_at: "2026-11-09T14:02:00.000Z", recording_id: null, duration: 0, lines: [] };
    const { dialogue } = mergeSegments([first, empty, second]);
    expect(dialogue.filter((d) => d.speaker === "divider")).toHaveLength(1);
    expect(mergeSegments([empty, second]).dialogue.some((d) => d.speaker === "divider")).toBe(false);
  });

  it("segments with no order time go last, in key order", () => {
    const a = makeSegment([line("caller", "zzz")]);
    const b = makeSegment([line("caller", "aaa")]);
    const sorted = sortSegments([a, b, second, first]);
    expect(sorted.slice(0, 2)).toEqual([first, second]);
    expect(sorted.slice(2).map((s) => s.key)).toEqual([a.key, b.key].sort());
  });

  it("redaction covers the merged output, even for a segment that skipped makeSegment", () => {
    const raw: TranscriptSegment = {
      key: "seg_raw",
      order_at: "2026-11-09T14:10:00.000Z",
      recording_id: null,
      duration: 5,
      lines: [line("caller", `Card is ${CARD}`), line("caller", "378282246310005")],
    };
    const { dialogue, transcript } = mergeSegments([first, raw]);
    expect(JSON.stringify(dialogue)).not.toMatch(/4111|378282246310005/);
    expect(transcript).not.toMatch(/4111|378282246310005/);
    expect(transcript).toContain(`Caller: Card is ${REDACTED_CARD}`);
  });

  it("makeSegment redacts on the way in", () => {
    const s = makeSegment([line("caller", `Use ${CARD}`)]);
    expect(s.lines[0].content).toBe(`Use ${REDACTED_CARD}`);
  });
});
