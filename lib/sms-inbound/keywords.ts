/**
 * Which inbound texts change anything (Plan B.4, decisions 2026-11-13). Pure.
 *
 *   the whole message is an opt-out keyword   -> opt_out (CANCEL also flags staff)
 *   the whole message is START or UNSTOP      -> opt_in (ends the opt-out; consent is not restored)
 *   an opt-out word inside a longer message   -> review: texts to that number are
 *                                                blocked until staff resolve it
 *   anything else (HELP included)             -> null: not stored at all
 *
 * "The whole message" means after Unicode normalization, trimming, dropping
 * leading/trailing punctuation and emoji, folding case, and treating runs of
 * spaces, hyphens and underscores as one space: "Stop.", " stop! ", "STOP 🛑",
 * "opt-out" and "Stop All" all count.
 *
 * END is a keyword on its own, but inside a sentence it is not flagged: "at the
 * end of the driveway" is ordinary placement directions here, and a flag
 * blocks texting that customer until staff look.
 */

export type InboundKind = "opt_out" | "opt_in" | "review";
export type InboundKeyword =
  | "STOP"
  | "STOPALL"
  | "UNSUBSCRIBE"
  | "CANCEL"
  | "END"
  | "QUIT"
  | "REVOKE"
  | "OPTOUT"
  | "START"
  | "UNSTOP";

export interface Classified {
  kind: InboundKind;
  keyword: InboundKeyword;
}

/** Whole-message forms, after normalize(). */
const EXACT: Record<string, Classified> = {
  STOP: { kind: "opt_out", keyword: "STOP" },
  STOPALL: { kind: "opt_out", keyword: "STOPALL" },
  "STOP ALL": { kind: "opt_out", keyword: "STOPALL" },
  UNSUBSCRIBE: { kind: "opt_out", keyword: "UNSUBSCRIBE" },
  CANCEL: { kind: "opt_out", keyword: "CANCEL" },
  END: { kind: "opt_out", keyword: "END" },
  QUIT: { kind: "opt_out", keyword: "QUIT" },
  REVOKE: { kind: "opt_out", keyword: "REVOKE" },
  OPTOUT: { kind: "opt_out", keyword: "OPTOUT" },
  "OPT OUT": { kind: "opt_out", keyword: "OPTOUT" },
  START: { kind: "opt_in", keyword: "START" },
  UNSTOP: { kind: "opt_in", keyword: "UNSTOP" },
};

/** Words that flag a longer message for staff (END deliberately not here). */
const IN_SENTENCE: Record<string, InboundKeyword> = {
  STOP: "STOP",
  STOPALL: "STOPALL",
  UNSUBSCRIBE: "UNSUBSCRIBE",
  CANCEL: "CANCEL",
  QUIT: "QUIT",
  REVOKE: "REVOKE",
  OPTOUT: "OPTOUT",
};

export function normalizeInbound(text: string): string {
  // Every keyword is ASCII once NFKC has folded full-width letters, so the edges
  // are trimmed to the first and last ASCII letter or digit.
  return text
    .normalize("NFKC")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .replace(/[\s_-]+/g, " ")
    .toUpperCase();
}

export function classifyInbound(text: string | null | undefined): Classified | null {
  if (typeof text !== "string") return null;
  const norm = normalizeInbound(text);
  if (!norm) return null;
  const exact = EXACT[norm];
  if (exact) return exact;

  const words = norm.split(/[^A-Z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "OPT" && words[i + 1] === "OUT") return { kind: "review", keyword: "OPTOUT" };
    const k = IN_SENTENCE[w];
    if (k) return { kind: "review", keyword: k };
  }
  return null;
}
