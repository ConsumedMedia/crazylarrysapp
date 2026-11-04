/**
 * /bookings/new with pay links ON: which actions the form posts to, the
 * consent script, the contact rule on the Book button, the secondary
 * "without a pay link" button, and the result card after Book.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock, formActionsUsed, formStateFor } from "@/test/form-hooks";
import { createStaffBookingAction } from "../actions";
import { createPayLinkBookingAction } from "./pay-link-actions";
import { PayLinkSubmitArea, CONSENT_SCRIPT } from "./_components/PayLinkBookingForm";
import { PayLinkResult } from "../_components/PayLinkResult";
import type { FormReadiness } from "./_components/NewBookingForm";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "staff-1", role: "owner" }) }));
vi.mock("@/app/(customer)/book/_components/AvailabilityCalendar", () => ({
  AvailabilityCalendar: () => <div data-stub="calendar" />,
}));
vi.mock("../actions", () => ({ createStaffBookingAction: vi.fn() }));
vi.mock("./pay-link-actions", () => ({ createPayLinkBookingAction: vi.fn() }));
let enabled = true;
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled }) }));
vi.mock("@/lib/customers/queries", () => ({ getCustomerDetail: async () => null }));
vi.mock("@/lib/bookings/pricing", () => ({
  getPricingConfig: async () => ({
    sizes: [{ size: "15yd", base_price: 350, included_days: 7, included_tons: 2, is_active: true }],
    settings: { tax_rate: 0.0725 },
    bookingReady: true,
  }),
}));

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const URL_ = `https://app.crazylarrysdumpsters.com/pay/${TOKEN}`;

async function renderPage() {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ searchParams: {} }));
}
const area = (r: Partial<FormReadiness>, extra: { error?: string } = {}) =>
  renderToStaticMarkup(
    <PayLinkSubmitArea
      readiness={{ ready: true, contactEmail: "", contactPhone: "", smsConsent: false, ...r }}
      plainAction={() => {}}
      {...extra}
    />,
  );

beforeEach(() => {
  enabled = true;
  formActionsUsed.length = 0;
  formStateFor.clear();
});

describe("/bookings/new with pay links ON", () => {
  it("posts to the pay-link action, with today's action only behind the secondary button", async () => {
    const html = await renderPage();
    expect(formActionsUsed).toEqual([createPayLinkBookingAction, createStaffBookingAction]);
    expect(html).toContain("Book and send pay link");
    expect(html).toContain("Create unpaid without a pay link");
    expect(html).toContain("A booking made this way gets no pay link and no payment reminders.");
    expect(html).toContain("Book creates the booking and sends");
  });

  it("tells staff what to say before ticking the texts box", async () => {
    const html = await renderPage();
    expect(CONSENT_SCRIPT).toContain("Can we text you the payment link");
    expect(html).toContain("Can we text you the payment link and updates about this booking?");
    expect(html).toContain("Reply STOP any time to stop texts.");
    expect(html).toContain("Tick only if they say yes.");
  });

  it("the switch OFF renders today's form and nothing from pay links", async () => {
    enabled = false;
    const html = await renderPage();
    expect(formActionsUsed).toEqual([createStaffBookingAction]);
    expect(html).not.toContain("Book and send pay link");
    expect(html).not.toContain("without a pay link");
    expect(html).not.toContain("Reply STOP");
    expect(html).toContain("Create booking (unpaid)");
  });
});

describe("contact rule on the Book button", () => {
  const bookDisabled = (html: string) => /<button disabled=""[^>]*>Book and send pay link/.test(html);

  it("no date/price yet: Book disabled, no contact reason", () => {
    const html = area({ ready: false, contactEmail: "a@b.test" });
    expect(bookDisabled(html)).toBe(true);
    expect(html).not.toContain("book-disabled-reason");
  });
  it("email only: enabled", () => {
    expect(bookDisabled(area({ contactEmail: "a@crazylarrys.test" }))).toBe(false);
  });
  it("phone without text consent: disabled and says why", () => {
    const html = area({ contactPhone: "614-555-0142" });
    expect(bookDisabled(html)).toBe(true);
    expect(html).toContain("Add an email, or a phone number and tick that the customer agreed to texts");
  });
  it("phone with text consent: enabled", () => {
    expect(bookDisabled(area({ contactPhone: "614-555-0142", smsConsent: true }))).toBe(false);
  });
  it("nothing at all: disabled and says why; the secondary button stays usable", () => {
    const html = area({});
    expect(bookDisabled(html)).toBe(true);
    expect(html).toContain("book-disabled-reason");
    expect(html).not.toMatch(/disabled=""[^>]*>Create unpaid without a pay link/);
  });
  it("a whitespace-only email does not count", () => {
    expect(bookDisabled(area({ contactEmail: "   " }))).toBe(true);
  });
});

describe("after Book: what was sent, and the link only when nothing went out", () => {
  it("email sent: lists it, no link on screen", () => {
    const html = renderToStaticMarkup(
      <PayLinkResult
        title="Booked"
        sent={[
          { channel: "sms", status: "skipped", category: "no_consent", redirected: false },
          { channel: "email", status: "sent", category: null, redirected: false },
        ]}
        url={null}
      />,
    );
    expect(html).toContain("Text not sent: the customer hasn&#x27;t agreed to texts");
    expect(html).toContain("Email sent");
    expect(html).not.toContain("/pay/");
    expect(html).not.toContain("Copy");
  });

  it("redirected by CL_NOTIFICATIONS_TEST_TO: says so", () => {
    const html = renderToStaticMarkup(
      <PayLinkResult title="Booked" sent={[{ channel: "email", status: "sent", category: null, redirected: true }]} url={null} />,
    );
    expect(html).toContain("Email sent — to the test address (CL_NOTIFICATIONS_TEST_TO)");
  });

  it("nothing sent: the link once, with Copy and the warning", () => {
    const html = renderToStaticMarkup(
      <PayLinkResult
        title="Booked"
        sent={[{ channel: "sms", status: "skipped", category: "recipient_missing", redirected: false }]}
        url={URL_}
      />,
    );
    expect(html).toContain(`value="${URL_}"`);
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("it is shown only now");
  });

  it("the whole form swaps to the result card, with no redirect and the link only in the card", async () => {
    formStateFor.set(createPayLinkBookingAction, {
      ok: true,
      bookingId: "bk-9",
      sent: [{ channel: "email", status: "failed", category: "transient", redirected: false }],
      url: URL_,
    });
    const html = await renderPage();
    expect(html).toContain("Booked — pay link issued.");
    expect(html).toContain('href="/bookings/bk-9"');
    expect(html.split(TOKEN).length - 1).toBe(1); // exactly once: the read-only input
    expect(html).not.toContain(`href="${URL_}`);
    expect(html).not.toContain("Book and send pay link");
  });

  it("an action error shows above the Book button", () => {
    const html = area({ contactEmail: "a@b.test" }, { error: "Pay links are turned off in Settings." });
    expect(html).toContain("Pay links are turned off in Settings.");
  });
});
