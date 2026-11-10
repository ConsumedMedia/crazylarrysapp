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
  transcript_purged_at: null,
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
      { speaker: "unknown", content: "Line with no speaker ids.", start: 70.62, end: 71.4, user_id: null, has_identifier: false },
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
  // Paused and resumed: two segments with a divider between them.
  {
    ...base,
    id: "r5",
    caller_number: "+16145550188",
    transcript: "Staff: First part\n— Call resumed —\nCaller: Second part",
    transcript_dialogue: [
      { speaker: "staff", content: "First part", start: 0 },
      { speaker: "divider", content: "Call resumed", start: null, end: null, user_id: null, has_identifier: false },
      { speaker: "caller", content: "Second part", start: 0 },
    ],
  },
  // Purged: text gone, summary kept.
  {
    ...base,
    id: "r4",
    caller_number: "+16145550177",
    summary: "Asked about a 10 yard.",
    transcript_purged_at: "2027-04-27T12:00:00.000Z",
  },
];

vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({}) }));
vi.mock("@/lib/call-log/queries", () => ({ listCallTranscripts: async () => ROWS }));

describe("/call-log page", () => {
  it("renders caller, customer links, missed highlight, summary, next steps, voicemail and transcript", async () => {
    const { default: CallLogPage } = await import("./page");
    const html = renderToStaticMarkup(await CallLogPage());

    expect(html).toContain("5 on file, 1 missed");
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
    // A line with neither a userId nor an identifier says Unknown, not Caller; a fractional start shows whole seconds.
    expect(html).toMatch(/1:10<\/span><span[^>]*>Unknown<\/span><span[^>]*>Line with no speaker ids\./);
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

  it("a divider line shows as a plain marker: no Staff, Caller or Unknown label and no time", async () => {
    const { default: CallLogPage } = await import("./page");
    const html = renderToStaticMarkup(await CallLogPage());
    const divider = html.match(/<li[^>]*data-divider=""[^>]*>([\s\S]*?)<\/li>/);
    expect(divider).not.toBeNull();
    expect(divider![1].replace(/<!-- -->/g, "").trim()).toBe("— Call resumed —");
    expect(divider![0]).not.toMatch(/Staff|Caller|Unknown|0:00/);
    // Exactly one divider, and the two spoken lines around it keep their labels.
    expect(html.match(/data-divider/g)).toHaveLength(1);
    expect(html).toMatch(/>Staff<\/span><span[^>]*>First part</);
    expect(html).toMatch(/>Caller<\/span><span[^>]*>Second part</);
  });

  it("a purged call says its transcript was removed after 180 days, once, and keeps its summary", async () => {
    const { default: CallLogPage } = await import("./page");
    const html = renderToStaticMarkup(await CallLogPage());
    expect(html.match(/Transcript removed after 180 days/g)).toHaveLength(1);
    const r4 = html.slice(html.indexOf("(614) 555-0177"));
    expect(r4).toContain("Transcript removed after 180 days");
    expect(r4).toContain("<li>Asked about a 10 yard.</li>");
    // Rows that were never purged don't say it, including r3 which simply has no transcript.
    expect(html.slice(0, html.indexOf("(614) 555-0177"))).not.toContain("Transcript removed");
  });
});
