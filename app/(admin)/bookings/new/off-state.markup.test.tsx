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

let pricing: PricingConfig;
let customer: Record<string, unknown> | null = null;
vi.mock("@/lib/bookings/pricing", () => ({ getPricingConfig: async () => pricing }));
vi.mock("@/lib/customers/queries", () => ({ getCustomerDetail: async () => customer }));

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
      id: "cust-1",
      full_name: "Pat Example",
      email: "pat@crazylarrys.test",
      phone: "+16145550142",
      company_name: "Example Roofing",
    };
    expect(await render({ customer: "cust-1" })).toMatchSnapshot();
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
