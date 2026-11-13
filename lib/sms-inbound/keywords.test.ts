import { describe, it, expect } from "vitest";
import { classifyInbound, normalizeInbound } from "./keywords";

type Want = [string, "opt_out" | "opt_in" | "review" | null, string?];

const CASES: Want[] = [
  // whole-message opt-outs
  ["STOP", "opt_out", "STOP"],
  ["stop", "opt_out", "STOP"],
  ["Stop", "opt_out", "STOP"],
  ["  stop  ", "opt_out", "STOP"],
  ["Stop.", "opt_out", "STOP"],
  ["STOP!!!", "opt_out", "STOP"],
  ['"stop"', "opt_out", "STOP"],
  ["stop 🛑", "opt_out", "STOP"],
  ["🛑STOP🛑", "opt_out", "STOP"],
  ["\nSTOP\n", "opt_out", "STOP"],
  ["ＳＴＯＰ", "opt_out", "STOP"], // full-width letters (NFKC)
  ["STOPALL", "opt_out", "STOPALL"],
  ["stop all", "opt_out", "STOPALL"],
  ["Stop-All", "opt_out", "STOPALL"],
  ["unsubscribe", "opt_out", "UNSUBSCRIBE"],
  ["Unsubscribe.", "opt_out", "UNSUBSCRIBE"],
  ["CANCEL", "opt_out", "CANCEL"],
  ["cancel", "opt_out", "CANCEL"],
  ["end", "opt_out", "END"],
  ["END.", "opt_out", "END"],
  ["quit", "opt_out", "QUIT"],
  ["revoke", "opt_out", "REVOKE"],
  ["optout", "opt_out", "OPTOUT"],
  ["opt out", "opt_out", "OPTOUT"],
  ["Opt-Out", "opt_out", "OPTOUT"],
  ["opt_out", "opt_out", "OPTOUT"],
  // opt-in
  ["START", "opt_in", "START"],
  ["start", "opt_in", "START"],
  ["Unstop", "opt_in", "UNSTOP"],
  ["unstop!", "opt_in", "UNSTOP"],
  // an opt-out word inside a longer message: staff review (and texts blocked)
  ["Please stop texting me", "review", "STOP"],
  ["stop please", "review", "STOP"],
  ["STOP STOP", "review", "STOP"],
  ["Can you stop by tomorrow?", "review", "STOP"],
  ["I want to unsubscribe", "review", "UNSUBSCRIBE"],
  ["How do I cancel my order?", "review", "CANCEL"],
  ["cancel the dumpster", "review", "CANCEL"],
  ["I quit, no more messages", "review", "QUIT"],
  ["please opt me out", null],
  ["opt out of these please", "review", "OPTOUT"],
  ["I opt-out", "review", "OPTOUT"],
  ["revoke consent", "review", "REVOKE"],
  ["STOPALL now", "review", "STOPALL"],
  // END inside a sentence is ordinary directions: not flagged
  ["put it at the end of the driveway", null],
  ["End of the street by the hydrant", null],
  // never a keyword
  ["HELP", null],
  ["help", null],
  ["yes", null],
  ["Thanks!", null],
  ["stopped by earlier", null],
  ["unstoppable", null],
  ["cancellation fee?", null],
  ["weekend delivery?", null],
  ["", null],
  ["   ", null],
  ["🛑", null],
  ["...", null],
  // accented and non-Latin text around a keyword is still a longer message
  ["José says stop", "review", "STOP"],
  // a trailing non-ASCII character is trimmed like an emoji
  ["stop é", "opt_out", "STOP"],
];

describe("classifyInbound", () => {
  it.each(CASES)("%j", (text, kind, keyword) => {
    const got = classifyInbound(text);
    if (kind === null) expect(got).toBeNull();
    else expect(got).toEqual({ kind, keyword });
  });

  it("not a string (media-only message): null", () => {
    expect(classifyInbound(null)).toBeNull();
    expect(classifyInbound(undefined)).toBeNull();
  });

  it("normalizes case, edges and separators", () => {
    expect(normalizeInbound("  opt--out!! ")).toBe("OPT OUT");
  });
});
