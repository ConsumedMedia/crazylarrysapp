/**
 * Golden output of every notification template for ordinary values: the SMS,
 * the email subject, text and HTML, byte for byte. Taken before the escaping
 * change (Plan B.2) and must stay identical after it: escaping may only change
 * output for values holding < > & " ' or control characters.
 *
 * Pure rendering: no network, no database. CL_YARD_PHONE is set here and the
 * module re-imported, so .env.local can't change the snapshot.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type * as Templates from "./templates";

let T: typeof Templates;
const savedYard = process.env.CL_YARD_PHONE;

beforeAll(async () => {
  process.env.CL_YARD_PHONE = "(614) 555-0142";
  vi.resetModules();
  T = await import("./templates");
});
afterAll(() => {
  if (savedYard === undefined) delete process.env.CL_YARD_PHONE;
  else process.env.CL_YARD_PHONE = savedYard;
});

const booking = (over: Partial<Templates.BookingCtx> = {}): Templates.BookingCtx => ({
  contactName: "Pat Smith",
  size: "20yd",
  deliveryDate: "2026-11-12",
  pickupDate: "2026-11-19",
  address: "1 Test St, Columbus, OH 43004",
  total: 401.05,
  paid: true,
  ...over,
});

const URL_ = "https://app.crazylarrysdumpsters.com/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

describe("notification templates: golden output for ordinary values", () => {
  const cases: Array<[string, () => Templates.Rendered]> = [
    ["bookingConfirmation paid", () => T.bookingConfirmation(booking())],
    ["bookingConfirmation unpaid", () => T.bookingConfirmation(booking({ paid: false, size: "10yd" }))],
    ["deliveryReminder", () => T.deliveryReminder(booking())],
    ["pickupReminder", () => T.pickupReminder(booking({ size: "15yd" }))],
    [
      "deliveryComplete",
      () => T.deliveryComplete({ contactName: "Pat Smith", size: "20yd", address: "1 Test St, Columbus, OH 43004", pickupDate: "2026-11-19" }),
    ],
    ["pickupComplete", () => T.pickupComplete({ contactName: "Pat Smith", size: "20yd", address: "1 Test St, Columbus, OH 43004" })],
    ["overdueNotice", () => T.overdueNotice(booking())],
    [
      "jobAssigned delivery with notes",
      () =>
        T.jobAssigned({
          driverName: "Marcus Lee",
          jobType: "delivery",
          size: "20yd",
          address: "1 Test St, Columbus, OH 43004",
          scheduledDate: "2026-11-12",
          placementNotes: "Left side of the driveway, by the garage",
        }),
    ],
    [
      "jobAssigned pickup without notes",
      () =>
        T.jobAssigned({
          driverName: "Marcus Lee",
          jobType: "pickup",
          size: "15yd",
          address: "1 Test St, Columbus, OH 43004",
          scheduledDate: "2026-11-19",
          placementNotes: null,
        }),
    ],
    // The pay-link templates already escaped their HTML, so these use values
    // with ' and & to prove that escaping is unchanged too.
    ["payLink", () => T.payLink({ ...booking({ contactName: "Pat O'Neil & Co", paid: false }), url: URL_ })],
    ["payLinkReminder", () => T.payLinkReminder({ ...booking({ address: "1 O'Hara Rd & 2nd, Columbus, OH 43004", paid: false }), url: URL_ })],
    [
      "staffUnpaidAlert after_days",
      () =>
        T.staffUnpaidAlert({
          contactName: "Pat O'Neil & Co",
          phone: "614-555-0200",
          size: "20yd",
          deliveryDate: "2026-11-12",
          total: 401.05,
          daysUnpaid: 3,
          remindersSent: 1,
          bookingUrl: "https://app.crazylarrysdumpsters.com/bookings/00000000-0000-0000-0000-0000000000b2",
          reason: "after_days",
        }),
    ],
    [
      "staffUnpaidAlert reminder_sent, no phone",
      () =>
        T.staffUnpaidAlert({
          contactName: "Pat Smith",
          phone: null,
          size: "10yd",
          deliveryDate: "2026-11-12",
          total: 300,
          daysUnpaid: 0,
          remindersSent: 2,
          bookingUrl: "https://app.crazylarrysdumpsters.com/bookings/00000000-0000-0000-0000-0000000000b2",
          reason: "reminder_sent",
        }),
    ],
  ];

  for (const [name, render] of cases) {
    it(name, () => {
      expect(render()).toMatchSnapshot();
    });
  }
});
