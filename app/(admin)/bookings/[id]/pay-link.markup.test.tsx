/**
 * Booking page with pay links: the panel, Send/Resend with its two-step
 * confirm, the QuickBooks invoice hidden and cash/check behind "Paid another
 * way?" while a link is live — on and off.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock, formStateFor } from "@/test/form-hooks";
import type { BookingDetail } from "@/lib/bookings/types";
import type { PayLinkState } from "@/lib/pay-links/booking-state";
import { ResendBlock } from "./_components/PayLinkPanel";
import { resendPayLinkAction } from "./pay-link-actions";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "staff-1", role: "owner" }) }));
vi.mock("../actions", () => ({
  changeStatusAction: vi.fn(),
  setAgreementAction: vi.fn(),
  refundAction: vi.fn(),
  applyDrivewayFeeAction: vi.fn(),
  removeDrivewayFeeAction: vi.fn(),
  recordPaymentAction: vi.fn(),
  sendInvoiceAction: vi.fn(),
  checkPaymentAction: vi.fn(),
}));
vi.mock("./pay-link-actions", () => ({ resendPayLinkAction: vi.fn() }));
vi.mock("../../requests/_components/ResolveRequestForm", () => ({ ResolveRequestForm: () => null }));
vi.mock("@/lib/bookings/change-requests", () => ({ listChangeRequestsForBooking: async () => [] }));
vi.mock("@/lib/bookings/pricing", () => ({ getPricingConfig: async () => ({ settings: { driveway_fee_rate: 50 } }) }));

let enabled = true;
let link: PayLinkState;
let detail: BookingDetail;
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled }) }));
vi.mock("@/lib/pay-links/booking-state", () => ({ getPayLinkState: async () => link }));
vi.mock("@/lib/bookings/queries", () => ({ getBookingDetail: async () => detail }));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const NONE: PayLinkState = { active: null, links: [], remindersSent: 0, lastReminderAt: null, deliveries: [] };
const ACTIVE = {
  id: "pl-2",
  status: "active" as const,
  createdAt: "2026-11-03T15:00:00.000Z",
  createdByName: "Office Owner",
  endedAt: null,
  endedReason: null,
  agreementAckAt: null,
  chargeStartedAt: null,
  paidAt: null,
};
const LIVE: PayLinkState = {
  active: ACTIVE,
  links: [
    ACTIVE,
    { ...ACTIVE, id: "pl-1", status: "superseded", createdAt: "2026-11-02T15:00:00.000Z", endedAt: "2026-11-03T15:00:00.000Z" },
  ],
  remindersSent: 1,
  lastReminderAt: "2026-11-04T12:05:00.000Z",
  deliveries: [
    { type: "pay_link_reminder", channel: "email", status: "sent", category: null, at: "2026-11-04T12:05:00.000Z", redirected: true },
    { type: "pay_link", channel: "sms", status: "skipped", category: "no_consent", at: "2026-11-03T15:00:01.000Z", redirected: false },
    { type: "pay_link", channel: "email", status: "sent", category: null, at: "2026-11-03T15:00:01.000Z", redirected: true },
  ],
};

function makeDetail(over: Partial<BookingDetail["booking"]> = {}): BookingDetail {
  return {
    booking: {
      id: "bk-1",
      customer_id: "c1",
      dumpster_id: null,
      size_requested: "15yd",
      delivery_address: "12 Test St",
      delivery_date: "2026-11-06",
      pickup_date: "2026-11-13",
      status: "confirmed",
      placement_notes: null,
      debris_type: null,
      subtotal: 350,
      tax: 25.38,
      total: 375.38,
      quickbooks_invoice_id: null,
      payment_status: "unpaid",
      docusign_status: "not_sent",
      driveway_fee_applied: false,
      driveway_fee_amount: null,
      driveway_fee_applied_by: null,
      driveway_fee_applied_at: null,
      driveway_fee_note: null,
      driveway_fee_qb_invoice_id: null,
      source: "staff",
      created_by: "staff-1",
      created_at: "2026-11-03T15:00:00.000Z",
      updated_at: "2026-11-03T15:00:00.000Z",
      ...over,
    },
    dumpsterUnitNumber: null,
    drivewayFeeStaffName: null,
    createdByName: null,
    paymentRecordedByName: null,
    customer: { id: "c1", profile_id: null, full_name: "Pat Example", email: "pat@crazylarrys.test", phone: null, company_name: null },
    invoice: null,
    jobs: [],
    history: [],
  };
}

async function render() {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ params: { id: "bk-1" } }));
}

beforeEach(() => {
  enabled = true;
  link = NONE;
  detail = makeDetail();
  formStateFor.clear();
});

describe("live link, pay links ON", () => {
  it("panel: Live, sent when and by whom, reminders, channels, earlier links, Resend", async () => {
    link = LIVE;
    const html = await render();
    expect(html).toContain('data-testid="pay-link-panel"');
    expect(html).toMatch(/>Live</);
    expect(html).toContain("Nov 3, 10:00 AM by Office Owner");
    expect(html).toContain("1 sent · last Nov 4, 7:05 AM");
    // This line comes from notifications_log. These rows have no recorded
    // variable (rows logged before migration 20261112000000), so the label says
    // only "the test address". A row that recorded it is the next test.
    expect(html).toContain("Reminder · Email sent — to the test address · ");
    expect(html).not.toContain("(CL_NOTIFICATIONS_");
    expect(html).toContain("Text not sent: the customer hasn&#x27;t agreed to texts");
    expect(html).toContain("Replaced by a newer link");
    expect(html).toContain(">Resend pay link</button>");
    expect(html).not.toContain(TOKEN);
  });

  it("a logged delivery that recorded its test variable names it; one that didn't says only 'the test address'", async () => {
    link = {
      ...LIVE,
      deliveries: [
        { type: "pay_link_reminder", channel: "email", status: "sent", category: null, at: "2026-11-04T12:05:00.000Z", redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_EMAIL" },
        { type: "pay_link", channel: "sms", status: "sent", category: null, at: "2026-11-03T15:00:01.000Z", redirected: true, redirectedVia: "CL_NOTIFICATIONS_TEST_PHONE" },
        { type: "pay_link", channel: "email", status: "sent", category: null, at: "2026-11-03T15:00:01.000Z", redirected: true },
      ],
    };
    const html = await render();
    expect(html).toContain("Reminder · Email sent — to the test address (CL_NOTIFICATIONS_TEST_EMAIL) · ");
    expect(html).toContain("Text sent — to the test address (CL_NOTIFICATIONS_TEST_PHONE) · ");
    expect(html.match(/Email sent — to the test address · /g)).toHaveLength(1);
  });

  it("QuickBooks invoice hidden; cash/check only behind a collapsed 'Paid another way?' with the warning", async () => {
    link = LIVE;
    const html = await render();
    expect(html).not.toContain("Email QuickBooks invoice with pay link");
    expect(html).not.toContain("Or send a QuickBooks pay link");
    expect(html).toContain('<details class="border-2 border-line" data-testid="paid-another-way">');
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain("Paid another way?");
    expect(html).toContain("Recording cash or check marks this booking paid and ends the link");
    // The cash form exists only once, inside the details.
    expect(html.split("Mark as paid").length - 1).toBe(1);
    expect(html.indexOf("Mark as paid")).toBeGreaterThan(html.indexOf("Paid another way?"));
  });

  it("payment in progress shows as such", async () => {
    link = { ...LIVE, active: { ...ACTIVE, chargeStartedAt: "2026-11-04T16:59:00.000Z" } };
    expect(await render()).toMatch(/>Payment in progress</);
  });

  it("after Resend sent nothing: the new link is shown once in the panel", async () => {
    link = LIVE;
    formStateFor.set(resendPayLinkAction, {
      ok: true,
      sent: [{ channel: "email", status: "failed", category: "transient", redirected: false }],
      url: `https://app.crazylarrysdumpsters.com/pay/${TOKEN}`,
    });
    const html = await render();
    expect(html).toContain("New link issued.");
    expect(html.split(TOKEN).length - 1).toBe(1);
  });
});

describe("live link, pay links OFF (the link stays payable)", () => {
  it("panel stays, no Resend, says why; invoice and cash stay hidden", async () => {
    enabled = false;
    link = LIVE;
    const html = await render();
    expect(html).toContain('data-testid="pay-link-panel"');
    expect(html).toContain("Pay links are off: this link still works, but no reminders go out and it can&#x27;t be resent.");
    expect(html).not.toContain("Resend pay link");
    expect(html).not.toContain("Email QuickBooks invoice with pay link");
    expect(html).toContain("Paid another way?");
  });
});

describe("no live link", () => {
  it("pay links ON, unpaid: 'Send pay link'; invoice and cash shown as today", async () => {
    const html = await render();
    expect(html).toContain("No pay link is live for this booking.");
    expect(html).toContain(">Send pay link</button>");
    expect(html).toContain("Email QuickBooks invoice with pay link");
    expect(html).not.toContain("Paid another way?");
  });

  it("pay links ON, paid: panel without a Send button", async () => {
    detail = makeDetail({ payment_status: "paid" });
    const html = await render();
    expect(html).toContain('data-testid="pay-link-panel"');
    expect(html).not.toContain("Send pay link");
  });

  it("pay links OFF: no panel at all", async () => {
    enabled = false;
    const html = await render();
    expect(html).not.toContain("pay-link-panel");
    expect(html).not.toContain("Send pay link");
  });
});

describe("Resend two-step confirm", () => {
  const block = (stage: "idle" | "confirm", hasActive = true) =>
    renderToStaticMarkup(
      <ResendBlock bookingId="bk-1" hasActive={hasActive} stage={stage} onAsk={() => {}} onCancel={() => {}} action={() => {}} />,
    );
  it("first step is only a button, no form", () => {
    const html = block("idle");
    expect(html).toContain(">Resend pay link</button>");
    expect(html).not.toContain("<form");
  });
  it("second step says the old link stops working and offers keep or send", () => {
    const html = block("confirm");
    expect(html).toContain("The old link stops working right away");
    expect(html).toContain("Yes, send a new link");
    expect(html).toContain("Keep the current link");
    expect(html).toContain('name="id" value="bk-1"');
  });
  it("first send (no live link) words it as a new link", () => {
    const html = block("confirm", false);
    expect(html).toContain("This makes a pay link and sends it to the customer.");
    expect(html).not.toContain("old link");
  });
});
