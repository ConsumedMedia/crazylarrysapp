/**
 * Unit test — renders the call-log server component to HTML with the query
 * and auth mocked. No database: the real query needs migration
 * 20261028000000_quo_call_log, and this checks the page logic before that is
 * applied.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CallTranscriptRow } from "@/lib/call-log/queries";

const base: CallTranscriptRow = {
  id: "r0",
  quo_call_id: "AC0",
  caller_number: "+16145550142",
  customer_id: null,
  customer_name: null,
  matched_customers: [],
  match_status: "none",
  direction: "incoming",
  call_status: "answered",
  call_started_at: "2026-10-28T14:00:00.000Z",
  has_voicemail: false,
  duration_seconds: 55,
  summary: null,
  next_steps: [],
  transcript: null,
  transcript_dialogue: [],
  voicemail_transcript: null,
  received_at: "2026-10-28T14:01:00.000Z",
};

const ROWS: CallTranscriptRow[] = [
  {
    ...base,
    id: "r1",
    customer_id: "c1",
    customer_name: "Pat Example",
    match_status: "matched",
    summary: "Wants a 20 yard Friday.\nAsked about driveway boards.",
    next_steps: ["Call back with price"],
    transcript: "Staff: Hello\nCaller: Hi",
    transcript_dialogue: [
      { speaker: "staff", content: "Crazy Larry's, how can I help?", start: 0 },
      { speaker: "caller", content: "It's [card number removed], thanks.", start: 65 },
    ],
  },
  {
    ...base,
    id: "r2",
    call_status: "missed",
    has_voicemail: true,
    duration_seconds: null,
    match_status: "multiple",
    matched_customers: [
      { id: "c2", full_name: "Twin A" },
      { id: "c3", full_name: "Twin B" },
    ],
    voicemail_transcript: "Call me back about a pickup.",
  },
  { ...base, id: "r3", direction: "outgoing", caller_number: null, match_status: null },
];

vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({}) }));
vi.mock("@/lib/call-log/queries", () => ({ listCallTranscripts: async () => ROWS }));

describe("/call-log page", () => {
  it("renders caller, customer links, missed highlight, summary, next steps, voicemail and transcript", async () => {
    const { default: CallLogPage } = await import("./page");
    const html = renderToStaticMarkup(await CallLogPage());

    expect(html).toContain("3 on file, 1 missed");
    // Linked customer, with the number alongside.
    expect(html).toContain('href="/customers/c1"');
    expect(html).toContain("Pat Example");
    expect(html).toContain("(614) 555-0142");
    // Summary bullets + next steps.
    expect(html).toContain("<li>Wants a 20 yard Friday.</li>");
    expect(html).toContain("<li>Asked about driveway boards.</li>");
    expect(html).toContain("Call back with price");
    // Expandable transcript, staff/caller labelled, offsets shown.
    expect(html).toContain("<details");
    expect(html).toContain("Crazy Larry&#x27;s, how can I help?");
    expect(html).toContain("1:05");
    expect(html).toContain("[card number removed]");
    // Missed call: highlighted + labelled, several customers listed, none linked as "the" customer.
    expect(html).toContain("Missed · voicemail");
    expect(html).toContain("border-l-orange");
    expect(html).toContain("2 customers share this number");
    expect(html).toContain('href="/customers/c2"');
    expect(html).toContain('href="/customers/c3"');
    expect(html).toContain("Call me back about a pickup.");
    // Outgoing call with no number.
    expect(html).toContain("Outgoing");
    expect(html).toContain("Unknown caller");
    // Only the missed row is highlighted.
    expect(html.match(/border-l-orange/g)).toHaveLength(1);
  });
});
