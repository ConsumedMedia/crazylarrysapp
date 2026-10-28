/** Unit test — pure display helpers. */
import { describe, it, expect } from "vitest";
import { isMissedCall, summaryLines, callLabel } from "./display";

describe("call-log display helpers", () => {
  it.each(["missed", "unanswered", "abandoned", "no-answer"])("incoming %s is a missed call", (s) => {
    expect(isMissedCall("incoming", s)).toBe(true);
  });

  it("answered, outgoing, or unknown calls are not missed", () => {
    expect(isMissedCall("incoming", "answered")).toBe(false);
    expect(isMissedCall("outgoing", "unanswered")).toBe(false);
    expect(isMissedCall(null, "missed")).toBe(false);
    expect(isMissedCall("incoming", null)).toBe(false);
  });

  it("labels", () => {
    expect(callLabel("incoming", "missed", true)).toBe("Missed · voicemail");
    expect(callLabel("incoming", "abandoned", null)).toBe("Missed");
    expect(callLabel("incoming", "answered", false)).toBe("Incoming");
    expect(callLabel("outgoing", "answered", false)).toBe("Outgoing");
    expect(callLabel(null, null, null)).toBe("Call");
  });

  it("summary lines drop blanks", () => {
    expect(summaryLines("One.\n\n Two. \n")).toEqual(["One.", "Two."]);
    expect(summaryLines(null)).toEqual([]);
  });
});
