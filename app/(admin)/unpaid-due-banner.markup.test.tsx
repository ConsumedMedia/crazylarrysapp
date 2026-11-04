/**
 * The delivery-day "not paid" warning on dispatch, the booking page and the
 * driver's job page — shown regardless of the pay-link switch. Warn only:
 * every control that was there is still there.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import type { DispatchJob } from "@/lib/dispatch/types";
import type { BookingDetail } from "@/lib/bookings/types";
import { NOT_DUE_JOBS } from "@/test/fixtures/dispatch-jobs";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dispatch",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "s", role: "owner" }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("./dispatch/actions", () => ({
  assignJobAction: vi.fn(),
  unassignJobAction: vi.fn(),
  reorderAction: vi.fn(),
  confirmTagsAction: vi.fn(),
}));
vi.mock("./schedule/actions", () => ({ createBlockAction: vi.fn(), deleteBlockAction: vi.fn() }));
vi.mock("@/app/(driver)/driver/actions", () => ({ completeJobAction: vi.fn() }));
vi.mock("./bookings/actions", () => ({
  changeStatusAction: vi.fn(),
  setAgreementAction: vi.fn(),
  refundAction: vi.fn(),
  applyDrivewayFeeAction: vi.fn(),
  removeDrivewayFeeAction: vi.fn(),
  recordPaymentAction: vi.fn(),
  sendInvoiceAction: vi.fn(),
  checkPaymentAction: vi.fn(),
}));
vi.mock("./bookings/[id]/pay-link-actions", () => ({ resendPayLinkAction: vi.fn() }));
vi.mock("./requests/_components/ResolveRequestForm", () => ({ ResolveRequestForm: () => null }));
vi.mock("@/lib/availability/blocks", () => ({ listBlocks: async () => [] }));
vi.mock("@/lib/bookings/change-requests", () => ({ listChangeRequestsForBooking: async () => [] }));
vi.mock("@/lib/bookings/pricing", () => ({ getPricingConfig: async () => ({ settings: { driveway_fee_rate: 0 } }) }));
vi.mock("@/lib/pay-links/booking-state", () => ({
  getPayLinkState: async () => ({ active: null, links: [], remindersSent: 0, lastReminderAt: null, deliveries: [] }),
}));
let payLinksOn = false;
vi.mock("@/lib/pay-links/settings", () => ({ getPayLinkSettings: async () => ({ enabled: payLinksOn }) }));

// The open test booking's shape: confirmed, unpaid, delivery 10-29, delivery job assigned for 10-29.
const DUE_DELIVERY: DispatchJob = {
  ...NOT_DUE_JOBS[0],
  id: "job-due",
  status: "assigned",
  driver_id: "drv-1",
  scheduled_date: "2026-10-29",
  booking_id: "9ed0e892-fb0c-4620-8802-06233f6b3007",
  payment_status: "unpaid",
  delivery_date: "2026-10-29",
  booking_status: "confirmed",
};
const DUE_PICKUP: DispatchJob = { ...DUE_DELIVERY, id: "job-due-pickup", type: "pickup", scheduled_date: "2026-11-04" };

let unassigned: DispatchJob[] = [];
let lane: DispatchJob[] = [];
let unpaidDue: Array<{ bookingId: string; deliveryDate: string; address: string; customerName: string }> = [];
vi.mock("@/lib/dispatch/queries", () => ({
  listUnassignedJobs: async () => unassigned,
  listDrivers: async () => [
    { id: "drv-1", profile_id: "p", full_name: "Marcus Driver", phone: null, vehicle_info: null, active: true, truck_id: null, truck_nickname: null, truck_status: null },
  ],
  listAvailableUnits: async () => [],
  listDriverJobs: async () => lane,
  checkMatrix: async () => ({}),
  listUnpaidDue: async () => unpaidDue,
}));
let driverJob: DispatchJob;
vi.mock("@/lib/driver/queries", () => ({
  myJob: async () => driverJob,
  myJobs: async () => ({ jobs: [driverJob] }),
}));
let detail: BookingDetail;
vi.mock("@/lib/bookings/queries", () => ({ getBookingDetail: async () => detail }));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
  process.env.CL_YARD_PHONE = "+16145550100";
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  payLinksOn = false;
  unassigned = [];
  lane = [];
  unpaidDue = [];
});

function bookingDetail(over: Partial<BookingDetail["booking"]>): BookingDetail {
  return {
    booking: {
      id: "9ed0e892-fb0c-4620-8802-06233f6b3007",
      customer_id: "c",
      dumpster_id: null,
      size_requested: "15yd",
      delivery_address: "12 Test St",
      delivery_date: "2026-10-29",
      pickup_date: "2026-11-03",
      status: "confirmed",
      placement_notes: null,
      debris_type: null,
      subtotal: 1,
      tax: 0,
      total: 1,
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
      created_by: null,
      created_at: "2026-10-28T15:00:00.000Z",
      updated_at: "2026-10-28T15:00:00.000Z",
      ...over,
    },
    dumpsterUnitNumber: null,
    drivewayFeeStaffName: null,
    createdByName: null,
    paymentRecordedByName: null,
    customer: { id: "c", profile_id: null, full_name: "Test Customer", email: null, phone: null, company_name: null },
    invoice: null,
    jobs: [],
    history: [],
  };
}

describe("dispatch", () => {
  it("top banner lists the unpaid-and-due booking with a link; lane card gets a Not paid chip", async () => {
    unpaidDue = [{ bookingId: DUE_DELIVERY.booking_id, deliveryDate: "2026-10-29", address: "12 Test St", customerName: "Test Customer" }];
    lane = [DUE_DELIVERY];
    const { default: Page } = await import("./dispatch/page");
    const html = renderToStaticMarkup(await Page({ searchParams: { driver: "drv-1", date: "2026-10-29" } }));
    expect(html).toContain('data-testid="unpaid-due-banner"');
    expect(html).toContain("Not paid — 1 booking is due");
    expect(html).toContain(`href="/bookings/${DUE_DELIVERY.booking_id}"`);
    expect(html).toContain("— delivery 2026-10-29");
    expect(html).toContain('data-testid="not-paid"');
    expect(html).toContain("Unassign"); // nothing blocked
  });

  it("queue card for a due job gets the chip; nothing due -> no banner, no chip", async () => {
    unassigned = [{ ...DUE_DELIVERY, status: "unassigned", driver_id: null }];
    const { default: Page } = await import("./dispatch/page");
    expect(renderToStaticMarkup(await Page({ searchParams: {} }))).toContain('data-testid="not-paid"');
    unassigned = NOT_DUE_JOBS.filter((j) => j.status === "unassigned");
    const html = renderToStaticMarkup(await Page({ searchParams: {} }));
    expect(html).not.toContain("unpaid-due-banner");
    expect(html).not.toContain('data-testid="not-paid"');
  });
});

describe("driver job page", () => {
  it("delivery: 'Not paid: call the office before delivering' with a call link; Complete still there", async () => {
    driverJob = DUE_DELIVERY;
    const { default: Page } = await import("@/app/(driver)/driver/[jobId]/page");
    const html = renderToStaticMarkup(await Page({ params: { jobId: "job-due" } }));
    expect(html).toContain('data-testid="driver-not-paid"');
    expect(html).toContain("Not paid: call the office before delivering");
    expect(html).toContain('href="tel:+16145550100"');
  });
  it("pickup of an unpaid booking: 'Not paid: call the office'", async () => {
    driverJob = DUE_PICKUP;
    const { default: Page } = await import("@/app/(driver)/driver/[jobId]/page");
    const html = renderToStaticMarkup(await Page({ params: { jobId: "job-due-pickup" } }));
    expect(html).toContain("Not paid: call the office<");
    expect(html).not.toContain("before delivering");
  });
  it("completed job: no warning", async () => {
    driverJob = { ...DUE_DELIVERY, status: "completed", completed_at: "2026-10-29T15:00:00.000Z" };
    const { default: Page } = await import("@/app/(driver)/driver/[jobId]/page");
    expect(renderToStaticMarkup(await Page({ params: { jobId: "job-due" } }))).not.toContain("driver-not-paid");
  });
});

describe("booking page — regardless of the pay-link switch", () => {
  for (const on of [false, true]) {
    it(`pay links ${on ? "ON" : "OFF"}: banner shows for the open test booking; controls unchanged`, async () => {
      payLinksOn = on;
      detail = bookingDetail({});
      const { default: Page } = await import("./bookings/[id]/page");
      const html = renderToStaticMarkup(await Page({ params: { id: detail.booking.id } }));
      expect(html).toContain('data-testid="unpaid-due-banner"');
      expect(html).toContain("Not paid, and delivery is due (Thu, Oct 29, 2026).");
      expect(html).toContain("Mark as paid");
    });
  }
  it("paid: no banner", async () => {
    detail = bookingDetail({ payment_status: "paid" });
    const { default: Page } = await import("./bookings/[id]/page");
    expect(renderToStaticMarkup(await Page({ params: { id: detail.booking.id } }))).not.toContain("unpaid-due-banner");
  });
});
