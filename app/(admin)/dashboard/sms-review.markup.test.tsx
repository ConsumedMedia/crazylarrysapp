/**
 * Needs action: texts that need a look (Plan B.4). Real markup; the server
 * action is a stub. With no reviews the panel is unchanged (NeedsAction's
 * existing snapshots pin that).
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SmsReview } from "@/lib/sms-inbound/reviews";
import { formHooksMock } from "@/test/form-hooks";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("./actions", () => ({ resolveRefundAction: vi.fn(), resolveSmsReviewAction: vi.fn() }));

import { NeedsAction } from "./_components/NeedsAction";
import { SmsReviewItemView } from "./_components/SmsReviewItem";

const REVIEW: SmsReview = {
  id: "11111111-1111-1111-1111-111111111111",
  reason: "keyword_in_message",
  keyword: "STOP",
  text: "Please <b>stop</b> texting me",
  receivedAt: "2026-11-13T15:00:00Z",
  customers: [{ id: "c1", name: "Pat Customer" }],
  numberHint: null,
};
const CANCEL: SmsReview = { ...REVIEW, id: "22222222-2222-2222-2222-222222222222", reason: "cancel_keyword", keyword: "CANCEL", text: null };

const render = (reviews: SmsReview[] | null) => renderToStaticMarkup(<NeedsAction overdueBookings={[]} unassignedJobs={[]} smsReviews={reviews} />);

describe("NeedsAction: texts that need a look", () => {
  it("none: the panel says nothing needs attention, exactly as before", () => {
    expect(render([])).toBe(renderToStaticMarkup(<NeedsAction overdueBookings={[]} unassignedJobs={[]} />));
    expect(render([])).toContain("Nothing needs attention right now.");
  });

  it("a flagged message: the count, who, the text (escaped), the hold, and two choices", () => {
    const html = render([REVIEW]);
    expect(html).toContain("Texts that need a look (1)");
    expect(html).toContain("Text mentions STOP — Pat Customer");
    expect(html).toContain("Please &lt;b&gt;stop&lt;/b&gt; texting me");
    expect(html).not.toContain("<b>stop</b>");
    expect(html).toContain("Texts to this number are on hold until you choose.");
    expect(html).toContain('value="treated_as_stop"');
    expect(html).toContain(">Treat as STOP</button>");
    expect(html).toContain('value="not_a_stop"');
    expect(html).toContain(">Not a STOP</button>");
    expect(html).not.toContain("Nothing needs attention");
  });

  it("CANCEL: says texts stopped, asks about a booking cancel, one choice", () => {
    const html = render([CANCEL]);
    expect(html).toContain("Texted CANCEL — Pat Customer");
    expect(html).toContain("Texts to this number have stopped. Check whether they meant to cancel a booking.");
    expect(html).toContain('value="checked"');
    expect(html).not.toContain('value="treated_as_stop"');
    expect(html).not.toContain('data-testid="sms-review-text"');
  });

  it("no customer: only the last four digits", () => {
    const html = render([{ ...REVIEW, customers: [], numberHint: "0143" }]);
    expect(html).toContain("a number ending 0143 (no customer)");
  });

  it("couldn't be read: says so instead of 'nothing needs attention'", () => {
    const html = render(null);
    expect(html).toContain('data-testid="sms-reviews-unreadable"');
    expect(html).not.toContain("Nothing needs attention");
  });

  it("each choice posts the event id and its outcome", () => {
    const html = renderToStaticMarkup(<SmsReviewItemView review={REVIEW} action={() => {}} />);
    expect(html.match(/name="id" value="11111111-1111-1111-1111-111111111111"/g)).toHaveLength(2);
  });
});
