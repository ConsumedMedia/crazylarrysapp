/**
 * Pins the exact HTML /bookings/new renders today. Written BEFORE the pay-link
 * staff UI (step d); with pay links off, that work must leave this snapshot
 * byte-identical.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock, formActionsUsed } from "@/test/form-hooks";
import { createStaffBookingAction } from "../actions";
import type { PricingConfig } from "@/lib/bookings/pricing";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ id: "staff-1", role: "owner" }) }));
vi.mock("@/app/(customer)/book/_components/AvailabilityCalendar", () => ({
  AvailabilityCalendar: () => <div data-stub="calendar" />,
}));
vi.mock("../actions", () => ({ createStaffBookingAction: vi.fn() }));
// Added with commit 2 (pay-link Book button): the switch reads OFF.
vi.mock("./pay-link-actions", () => ({ createPayLinkBookingAction: vi.fn() }));
// Changed with the customer autofill: the search actions, and ?customer= now
// loads the customer the same way a pick does.
vi.mock("./customer-actions", () => ({
  searchCustomersAction: vi.fn(),
  pickCustomerAction: vi.fn(),
  emailOwnerAction: vi.fn(),
}));
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled: false }) }));

let pricing: PricingConfig;
let customer: Record<string, unknown> | null = null;
vi.mock("@/lib/bookings/pricing", () => ({ getPricingConfig: async () => pricing }));
vi.mock("@/lib/customers/search", () => ({ pickCustomer: async () => customer }));

const READY: PricingConfig = {
  sizes: (["10yd", "15yd", "20yd"] as const).map((size, i) => ({
    size,
    base_price: 300 + i * 50,
    included_days: 7,
    included_tons: 2,
    is_active: true,
  })),
  settings: {
    extra_day_rate: 15,
    overage_ton_rate: 75,
    credit_card_fee_rate: 0.03,
    driveway_fee_rate: 50,
    tax_rate: 0.0725,
    tax_jurisdiction: "Franklin County, OH",
    tax_verified: true,
    tax_verified_note: null,
  },
  bookingReady: true,
};

async function render(searchParams: { customer?: string }) {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ searchParams }));
}

describe("/bookings/new markup (pay links off)", () => {
  it("blank form, pricing ready", async () => {
    pricing = READY;
    customer = null;
    expect(await render({})).toMatchSnapshot();
  });

  it("prefilled from an existing customer", async () => {
    pricing = READY;
    customer = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Pat Example",
      email: "pat@crazylarrys.test",
      phone: "+16145550142",
      company: "Example Roofing",
      bookings: 3,
      addresses: [
        { label: "1 Test St, Columbus, OH 43004", parts: { street: "1 Test St", city: "Columbus", state: "OH", zip: "43004" } },
        { label: "Lot 4 behind the barn", parts: null },
      ],
      consent: { onFile: true, last: { granted: true, source: "phone_verbal", recordedAt: "2026-11-03T15:00:00Z" } },
    };
    expect(await render({ customer: "11111111-1111-4111-8111-111111111111" })).toMatchSnapshot();
  });

  it("the form posts to today's createStaffBookingAction and nothing else", async () => {
    pricing = READY;
    customer = null;
    formActionsUsed.length = 0;
    await render({});
    expect(formActionsUsed).toEqual([createStaffBookingAction]);
  });

  it("pricing not configured", async () => {
    pricing = {
      ...READY,
      sizes: READY.sizes.map((s) => ({ ...s, base_price: 0, is_active: false })),
      bookingReady: false,
    };
    customer = null;
    expect(await render({})).toMatchSnapshot();
  });
});
