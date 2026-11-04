/**
 * Pins the exact HTML the staff booking page renders today, controls included.
 * Written BEFORE the pay-link staff UI (step d). Every fixture is NOT due for
 * delivery (delivery after the yard's today, or already paid), so the
 * delivery-day banner — which shows regardless of the pay-link switch — never
 * applies here. With pay links off and no live link, step (d) must leave this
 * snapshot byte-identical.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import type { BookingDetail } from "@/lib/bookings/types";
import type { PricingConfig } from "@/lib/bookings/pricing";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ id: "staff-1", role: "owner" }) }));
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
// Added with commit 3 (booking-page pay-link panel): switch OFF, no links.
vi.mock("./pay-link-actions", () => ({ resendPayLinkAction: vi.fn() }));
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled: false }) }));
vi.mock("@/lib/pay-links/booking-state", () => ({
  getPayLinkState: async () => ({ active: null, links: [], remindersSent: 0, lastReminderAt: null, deliveries: [] }),
}));
vi.mock("../../requests/_components/ResolveRequestForm", () => ({
  ResolveRequestForm: () => <div data-stub="resolve-request" />,
}));

let detail: BookingDetail | null = null;
vi.mock("@/lib/bookings/queries", () => ({ getBookingDetail: async () => detail }));
vi.mock("@/lib/bookings/change-requests", () => ({ listChangeRequestsForBooking: async () => [] }));
vi.mock("@/lib/bookings/pricing", () => ({
  getPricingConfig: async (): Promise<Partial<PricingConfig>> => ({
    settings: {
      extra_day_rate: 15,
      overage_ton_rate: 75,
      credit_card_fee_rate: 0.03,
      driveway_fee_rate: 50,
      tax_rate: 0.0725,
      tax_jurisdiction: null,
      tax_verified: true,
      tax_verified_note: null,
    },
  }),
}));

// Yard today is 2026-11-04 (noon in New York).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());

const booking: BookingDetail["booking"] = {
  id: "bk-1",
  customer_id: "cust-1",
  dumpster_id: null,
  size_requested: "15yd",
  delivery_address: "12 Test St, Columbus, OH 43215",
  delivery_date: "2026-11-06",
  pickup_date: "2026-11-13",
  status: "confirmed",
  placement_notes: "Placement: Driveway",
  debris_type: "Household junk",
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
};

const invoiceBase: NonNullable<BookingDetail["invoice"]> = {
  id: "inv-1",
  booking_id: "bk-1",
  amount: 375.38,
  status: "pending",
  qb_charge_id: null,
  qb_payment_id: null,
  qb_refund_id: null,
  refund_kind: null,
  refunded_amount: null,
  refunded_at: null,
  sync_status: "pending",
  quickbooks_invoice_id: null,
  paid_at: null,
  payment_method: null,
  payment_reference: null,
  payment_note: null,
  recorded_by: null,
  qb_invoice_link: null,
  invoice_sent_to: null,
  invoice_sent_at: null,
  qb_balance: null,
  qb_checked_at: null,
  failure_reason: null,
};

function make(over: { booking?: Partial<BookingDetail["booking"]>; invoice?: BookingDetail["invoice"] }): BookingDetail {
  return {
    booking: { ...booking, ...over.booking },
    dumpsterUnitNumber: null,
    drivewayFeeStaffName: null,
    createdByName: "Office Owner",
    paymentRecordedByName: null,
    customer: {
      id: "cust-1",
      profile_id: null,
      full_name: "Pat Example",
      email: "pat@crazylarrys.test",
      phone: "+16145550142",
      company_name: null,
    },
    invoice: over.invoice === undefined ? null : over.invoice,
    jobs: [
      {
        id: "job-1",
        booking_id: "bk-1",
        type: "delivery",
        driver_id: null,
        scheduled_date: "2026-11-06",
        status: "unassigned",
        route_order: null,
        completed_at: null,
      },
    ],
    history: [
      { id: "h1", entity_type: "booking", old_status: null, new_status: "confirmed", changed_at: "2026-11-03T15:00:00.000Z" },
    ],
  };
}

async function render(d: BookingDetail) {
  detail = d;
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ params: { id: d.booking.id } }));
}

describe("/bookings/[id] markup (pay links off, no live link, not due)", () => {
  it("unpaid staff booking, delivery in two days, no invoice", async () => {
    expect(await render(make({}))).toMatchSnapshot();
  });

  it("unpaid with a QuickBooks invoice sent", async () => {
    expect(
      await render(
        make({
          invoice: {
            ...invoiceBase,
            quickbooks_invoice_id: "QB-1001",
            qb_invoice_link: "https://app.sandbox.qbo.intuit.com/app/customer/pay/QB-1001",
            invoice_sent_to: "pat@crazylarrys.test",
            invoice_sent_at: "2026-11-03T16:00:00.000Z",
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("paid by cash, delivery already past (paid, so not due)", async () => {
    expect(
      await render(
        make({
          booking: { payment_status: "paid", delivery_date: "2026-11-02", status: "delivered" as BookingDetail["booking"]["status"] },
          invoice: {
            ...invoiceBase,
            status: "paid",
            payment_method: "cash",
            paid_at: "2026-11-02T14:00:00.000Z",
            sync_status: "synced",
            quickbooks_invoice_id: "QB-1002",
          },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("paid by card online", async () => {
    expect(
      await render(
        make({
          booking: { payment_status: "paid", source: "online", created_by: null },
          invoice: { ...invoiceBase, status: "paid", payment_method: "card", qb_charge_id: "CH-1", sync_status: "synced" },
        }),
      ),
    ).toMatchSnapshot();
  });

  it("cancelled while unpaid, delivery date past", async () => {
    expect(
      await render(make({ booking: { status: "cancelled", delivery_date: "2026-11-01" } })),
    ).toMatchSnapshot();
  });
});
