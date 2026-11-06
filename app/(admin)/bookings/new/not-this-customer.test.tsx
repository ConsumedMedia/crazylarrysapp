/**
 * "Not this customer", clicked through the real form code in both forms: type,
 * pick from the results, use an offered address, edit, click, then look at what
 * is left and at what the real server actions would receive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { formHooksMock, formActionsUsed } from "@/test/form-hooks";
import { mount } from "@/test/mini-render";
import type { PickedCustomer } from "@/lib/customers/search-shared";
import type { PricingConfig } from "@/lib/bookings/pricing";

vi.mock("react", async (orig) => {
  const { hooks } = await import("@/test/mini-render");
  return { ...(await orig<object>()), ...hooks };
});
vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));

// The calendar is the only way to pick a date, so the test drives its prop.
let selectDate: (d: string) => void = () => {};
vi.mock("@/app/(customer)/book/_components/AvailabilityCalendar", () => ({
  AvailabilityCalendar: (p: { onSelectDate: (d: string) => void }) => {
    selectDate = p.onSelectDate;
    return null;
  },
}));

const ID = "11111111-1111-4111-8111-111111111111";
const PICKED: PickedCustomer = {
  id: ID,
  name: "Pat Example",
  email: "pat@crazylarrys.test",
  phone: "614-555-0142",
  company: "Example Roofing",
  bookings: 3,
  addresses: [{ label: "1 Test St, Columbus, OH 43004", parts: { street: "1 Test St", city: "Columbus", state: "PA", zip: "43004" } }],
  consent: { onFile: true, last: null },
};
vi.mock("./customer-actions", () => ({
  searchCustomersAction: async () => ({
    ok: true,
    hits: [{ id: ID, name: "Pat Example", phone: "614-555-0142", company: "Example Roofing", bookings: 3 }],
  }),
  pickCustomerAction: async () => ({ ok: true, customer: PICKED }),
  emailOwnerAction: async () => ({ ok: true, name: "Lee Prepaid" }),
}));

// The real server actions run; only what lies beyond them is replaced.
const staffCreateBooking = vi.fn(async (input: unknown) => (void input, { bookingId: "bk-1" }));
const createPayLinkBooking = vi.fn(async (input: unknown) => (void input, { bookingId: "bk-1", sent: [], url: null }));
vi.mock("@/lib/bookings/staff-create", () => ({ staffCreateBooking: (i: unknown) => staffCreateBooking(i) }));
vi.mock("@/lib/pay-links/staff", () => ({
  createPayLinkBooking: (i: unknown) => createPayLinkBooking(i),
  PayLinkError: class PayLinkError extends Error {},
}));
vi.mock("@/lib/notifications/notify", () => ({ notifyBookingConfirmation: async () => {} }));
vi.mock("@/lib/bookings/mutations", () => ({}));
vi.mock("@/lib/auth/requireStaff", () => ({ NotAuthorizedError: class NotAuthorizedError extends Error {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));

import { NewBookingForm } from "./_components/NewBookingForm";
import { PayLinkBookingForm } from "./_components/PayLinkBookingForm";

const pricing = {
  sizes: [{ size: "15yd", base_price: 350, included_days: 7, included_tons: 2, is_active: true }],
  settings: { tax_rate: 0.0725 },
  bookingReady: true,
} as unknown as PricingConfig;

const FORMS = [
  { label: "off form", Form: NewBookingForm },
  { label: "pay-link form", Form: PayLinkBookingForm },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  formActionsUsed.length = 0;
  staffCreateBooking.mockClear();
  createPayLinkBooking.mockClear();
});
afterEach(() => vi.useRealTimers());

/** Type, wait out the debounce, pick the first result. */
async function pickPat(form: ReturnType<typeof mount>) {
  form.type("contactName", "Pat");
  await vi.advanceTimersByTimeAsync(250);
  form.pickResult();
  await vi.advanceTimersByTimeAsync(0);
}
const val = (form: ReturnType<typeof mount>, name: string) => form.input(name).props.value;

for (const { label, Form } of FORMS) {
  describe(label, () => {
    const start = () => mount(() => createElement(Form, { pricing, customer: null }));

    it("a pick fills the form (so the clear below is really clearing something)", async () => {
      const f = start();
      await pickPat(f);
      expect(val(f, "contactName")).toBe("Pat Example");
      expect(val(f, "contactEmail")).toBe("pat@crazylarrys.test");
      expect(f.input("customerId").props.value).toBe(ID);
      expect(f.text()).toContain("Existing customer");
    });

    it("Not this customer: every field empty, hidden id gone, banner, consent line, warnings and address options gone", async () => {
      const f = start();
      await pickPat(f);
      f.click("1 Test St, Columbus");
      expect(val(f, "street")).toBe("1 Test St");
      f.type("contactEmail", "lee@crazylarrys.test");
      await vi.advanceTimersByTimeAsync(400);
      expect(f.text()).toContain("That email already belongs to another customer: Lee Prepaid.");
      expect(f.text()).toContain("On file: agreed to texts");

      f.click("Not this customer");

      for (const name of ["contactName", "contactPhone", "contactEmail", "companyName", "street", "city", "zip"]) {
        expect(val(f, name), name).toBe("");
      }
      expect(val(f, "state")).toBe("OH"); // the blank form's default, not the offered address's PA
      expect(f.has("customerId")).toBe(false);
      const text = f.text();
      expect(text).not.toContain("Existing customer");
      expect(text).not.toContain("Not this customer");
      expect(text).not.toContain("On file");
      expect(text).not.toContain("Booking will update");
      expect(text).not.toContain("already belongs");
      expect(f.hasButton("1 Test St, Columbus")).toBe(false);
      expect(f.hasButton("New address")).toBe(false);
    });

    it("the texts box goes back to unticked, so consent can't carry over to the next person", async () => {
      const f = start();
      await pickPat(f);
      f.tick("smsConsent", true);
      expect(f.input("smsConsent").props.checked).toBe(true);
      f.click("Not this customer");
      expect(f.input("smsConsent").props.checked).toBe(false);
    });

    it("a hand-typed address stays; only an offered one is cleared", async () => {
      const f = start();
      await pickPat(f);
      f.type("street", "77 Typed Rd");
      f.type("city", "Delaware");
      f.click("Not this customer");
      expect(val(f, "street")).toBe("77 Typed Rd");
      expect(val(f, "city")).toBe("Delaware");
    });

    it("an offered address that New address already cleared doesn't take a later hand-typed one with it", async () => {
      const f = start();
      await pickPat(f);
      f.click("1 Test St, Columbus");
      f.click("New address");
      f.type("street", "77 Typed Rd");
      f.click("Not this customer");
      expect(val(f, "street")).toBe("77 Typed Rd");
    });

    it("after the clear, typing searches again and a new pick works", async () => {
      const f = start();
      await pickPat(f);
      f.click("Not this customer");
      await pickPat(f);
      expect(f.input("customerId").props.value).toBe(ID);
      expect(val(f, "contactEmail")).toBe("pat@crazylarrys.test");
    });
  });
}

describe("a leftover email can't be submitted after the clear", () => {
  it("off form: the real action gets no email, phone or customer id", async () => {
    const f = mount(() => createElement(NewBookingForm, { pricing, customer: null }));
    await pickPat(f);
    f.click("Not this customer");
    f.type("contactName", "Someone New");
    const [action] = formActionsUsed as Array<(s: unknown, fd: FormData) => Promise<unknown>>;
    await action({ ok: false }, f.formData());
    expect(staffCreateBooking).toHaveBeenCalledTimes(1);
    expect(staffCreateBooking.mock.calls[0][0]).toMatchObject({
      contactName: "Someone New",
      contactEmail: undefined,
      contactPhone: undefined,
      companyName: undefined,
      smsConsent: false,
      customerId: null,
    });
  });

  it("pay-link form: Book goes from enabled to disabled with the reason, and the real action gets no email or id", async () => {
    const f = mount(() => createElement(PayLinkBookingForm, { pricing, customer: null }));
    await pickPat(f);
    f.hosts();
    selectDate("2026-12-01");
    expect(f.button("Book and send pay link").props.disabled).toBe(false);

    f.click("Not this customer");
    expect(f.button("Book and send pay link").props.disabled).toBe(true);
    expect(f.text()).toContain("Add an email, or a phone number and tick");

    f.type("contactName", "Someone New");
    const payLink = formActionsUsed[0] as (s: unknown, fd: FormData) => Promise<unknown>;
    const fd = f.formData();
    fd.set("size", "15yd");
    await payLink({ ok: false }, fd);
    expect(createPayLinkBooking.mock.calls[0][0]).toMatchObject({
      contactName: "Someone New",
      contactEmail: undefined,
      contactPhone: undefined,
      smsConsent: false,
      customerId: null,
    });
  });
});
