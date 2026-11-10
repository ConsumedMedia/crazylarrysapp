/** Display helpers for the call log. Pure, so the page logic is testable. */

import { TRANSCRIPT_RETENTION_DAYS } from "./config";

/** Shown where a transcript was, once the purge has removed its text. */
export function transcriptRemovedText(days: number = TRANSCRIPT_RETENTION_DAYS): string {
  return `Transcript removed after ${days} days`;
}

/** Quo statuses that mean an incoming call nobody picked up. */
const MISSED_STATUSES = new Set(["missed", "unanswered", "abandoned", "no-answer"]);

export function isMissedCall(direction: string | null, status: string | null): boolean {
  return direction === "incoming" && status !== null && MISSED_STATUSES.has(status);
}

/** Stored summary is one line per Quo summary point. */
export function summaryLines(summary: string | null): string[] {
  return (summary ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

export function callLabel(direction: string | null, status: string | null, hasVoicemail: boolean | null): string {
  if (isMissedCall(direction, status)) return hasVoicemail ? "Missed · voicemail" : "Missed";
  if (direction === "outgoing") return "Outgoing";
  if (direction === "incoming") return "Incoming";
  return "Call";
}
