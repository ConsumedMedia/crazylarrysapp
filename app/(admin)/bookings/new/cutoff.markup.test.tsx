/**
 * The order cutoff on the staff form. Only "Book and send pay link" follows it;
 * "Create unpaid without a pay link" (a phone booking) and the phone form keep
 * tomorrow. Rendered to HTML; the page's floor comes from a fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import type { DeliveryFloor } from "@/lib/bookings/cutoff-shared";
import type { FormReadiness } from "./_components/NewBookingForm";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("../../actions", () => ({ createStaffBookingAction: vi.fn() }));
vi.mock("./pay-link-actions", () => ({ createPayLinkBookingAction: vi.fn() }));
vi.mock("./customer-actions", () => ({ searchCustomersAction: vi.fn(), pickCustomerAction: vi.fn(), emailOwnerAction: vi.fn() }));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "u1", role: "owner" }) }));
let enabled = true;
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled }) }));
vi.mock("@/lib/customers/search", () => ({ pickCustomer: async () => null }));
vi.mock("@/lib/bookings/pricing", () => ({
  getPricingConfig: async () => ({
    sizes: [{ size: "15yd", base_price: 350, included_days: 7, included_tons: 2, is_active: true }],
    settings: { tax_rate: 0.0725 },
    bookingReady: true,
  }),
}));
let floor: DeliveryFloor;
const getDeliveryFloor = vi.fn(async () => floor);
vi.mock("@/lib/bookings/cutoff", async () => ({ ...(await import("@/lib/bookings/cutoff-shared")), getDeliveryFloor: () => getDeliveryFloor() }));

import { PayLinkSubmitArea } from "./_components/PayLinkBookingForm";

const AFTER: DeliveryFloor = {
  earliestOnline: "2026-11-13",
  earliestStaff: "2026-11-12",
  cutoffEnabled: true,
  cutoffTime: "15:00",
  afterCutoff: true,
  nextChangeAt: "2026-11-12T05:00:00.000Z",
  source: "database",
};
const READY: FormReadiness = { ready: true, deliveryDate: "2026-11-12", contactEmail: "pat@crazylarrys.test", contactPhone: "", smsConsent: false };
const area = (readiness: FormReadiness, f: DeliveryFloor | null) =>
  renderToStaticMarkup(<PayLinkSubmitArea readiness={readiness} plainAction={() => {}} floor={f} />);
const disabled = (html: string, label: string) =>
  new RegExp(`<button[^>]*disabled=""[^>]*>${label}`).test(html);

beforeEach(() => {
  floor = AFTER;
  enabled = true;
  getDeliveryFloor.mockClear();
});

describe("pay-link submit area and the order cutoff", () => {
  it("after the cutoff, tomorrow: the pay-link button is disabled with the reason; the cash/check button isn't", () => {
    const html = area(READY, AFTER);
    expect(disabled(html, "Book and send pay link")).toBe(true);
    expect(disabled(html, "Create unpaid without a pay link")).toBe(false);
    expect(html).toContain('data-testid="book-cutoff-reason"');
    expect(html).toContain("After 3:00 PM, a pay-link booking can&#x27;t be delivered tomorrow. Pick Friday, Nov 13 or later");
  });

  it("the day after tomorrow, no floor, a fallback floor, or no date picked: no cutoff refusal", () => {
    for (const html of [
      area({ ...READY, deliveryDate: "2026-11-13" }, AFTER),
      area(READY, null),
      area(READY, { ...AFTER, earliestOnline: "2026-11-12", cutoffEnabled: false, afterCutoff: false, source: "fallback" }),
      area({ ...READY, ready: false, deliveryDate: null }, AFTER),
    ]) {
      expect(html).not.toContain("book-cutoff-reason");
    }
    expect(disabled(area({ ...READY, deliveryDate: "2026-11-13" }, AFTER), "Book and send pay link")).toBe(false);
  });

  it("the page reads the floor once with pay links on and hands it to the pay-link form", async () => {
    const { default: Page } = await import("./page");
    renderToStaticMarkup(await Page({ searchParams: {} }));
    expect(getDeliveryFloor).toHaveBeenCalledTimes(1);
  });

  it("with pay links off the page never reads the floor", async () => {
    enabled = false;
    const { default: Page } = await import("./page");
    const html = renderToStaticMarkup(await Page({ searchParams: {} }));
    expect(getDeliveryFloor).not.toHaveBeenCalled();
    expect(html).toContain("Earliest delivery is tomorrow.");
  });
});
