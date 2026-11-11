/**
 * The /book wizard asks its calendar for the order cutoff, and a day the
 * calendar reports closed is dropped from the wizard. Real wizard through
 * test/mini-render; the calendar is a stub that records its props.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { mount } from "@/test/mini-render";
import type { PricingConfig } from "@/lib/bookings/pricing";

vi.mock("react", async (orig) => {
  const { hooks } = await import("@/test/mini-render");
  return { ...(await orig<object>()), ...hooks };
});

type CalendarProps = {
  applyCutoff?: boolean;
  selectedDate?: string | null;
  onSelectDate: (d: string) => void;
  onDateClosed?: () => void;
};
let calendar: CalendarProps | null = null;
vi.mock("./AvailabilityCalendar", () => ({
  AvailabilityCalendar: (p: CalendarProps) => {
    calendar = p;
    return null;
  },
}));
vi.mock("./AgreementModal", () => ({ AgreementModal: () => null }));
vi.mock("./PaymentForm", () => ({ PaymentForm: () => null }));

import { BookingWizard } from "./BookingWizard";

const pricing = {
  sizes: (["10yd", "15yd", "20yd"] as const).map((size) => ({
    size,
    base_price: 350,
    included_days: 5,
    included_tons: 2,
    is_active: true,
  })),
  settings: { extra_day_rate: 0, overage_ton_rate: 0, credit_card_fee_rate: 0, driveway_fee_rate: 0, tax_rate: 0.0725 },
  bookingReady: true,
} as unknown as PricingConfig;

describe("/book wizard and the order cutoff", () => {
  it("the Dates step's calendar applies the cutoff, and a day it closes is cleared from the wizard", () => {
    const m = mount(() => createElement(BookingWizard, { pricing, docusignUrl: null, tokenizeUrl: "/x", paymentsReady: true }));
    m.click("Check dates");
    expect(calendar?.applyCutoff).toBe(true);
    expect(typeof calendar?.onDateClosed).toBe("function");

    calendar!.onSelectDate("2026-11-12");
    m.hosts();
    expect(calendar?.selectedDate).toBe("2026-11-12");

    calendar!.onDateClosed!();
    m.hosts();
    expect(calendar?.selectedDate).toBeNull();
  });
});
