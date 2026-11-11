/**
 * Unit test — the order cutoff on the pay-link path. createPayLinkBooking asks
 * the database for the floor (faked) and refuses a day the cutoff closed
 * before calling staff_create_pay_link_booking; nothing is created or sent.
 * The clock is pinned to Wed Nov 11, 2026, 4:00 PM Eastern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sessionRpc = vi.fn();
const notifyPayLink = vi.fn();
let floorReply: () => Promise<{ data: unknown; error: unknown }>;

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ rpc: sessionRpc }) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc: () => floorReply() }) }));
vi.mock("@/lib/auth/requireStaff", () => ({
  assertStaff: async () => ({ userId: "staff-1", role: "owner", email: null, fullName: null }),
}));
vi.mock("@/lib/notifications/notify", () => ({ notifyPayLink: (...a: unknown[]) => notifyPayLink(...a) }));

import { createPayLinkBooking } from "./staff";
import { BookingCreateError } from "@/lib/bookings/create";

const AFTER_ROW = {
  earliest_online: "2026-11-13",
  earliest_staff: "2026-11-12",
  cutoff_enabled: true,
  cutoff_time: "15:00:00",
  after_cutoff: true,
  next_change_at: "2026-11-12T05:00:00+00:00",
};
const input = (deliveryDate: string) => ({
  size: "15yd" as const,
  deliveryDate,
  street: "1 Test St",
  city: "Columbus",
  state: "OH",
  zip: "43215",
  contactName: "Pay Link Cutoff",
  contactEmail: "pay-link-cutoff@example.com",
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T21:00:00.000Z"));
  sessionRpc.mockReset();
  notifyPayLink.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  floorReply = async () => ({ data: [AFTER_ROW], error: null });
  sessionRpc.mockResolvedValue({ data: [{ booking_id: "bk-1", token: "A".repeat(43) }], error: null });
  notifyPayLink.mockResolvedValue([{ channel: "email", status: "sent" }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function refusal(p: Promise<unknown>): Promise<BookingCreateError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BookingCreateError);
    return e as BookingCreateError;
  }
  throw new Error("expected a refusal");
}

describe("createPayLinkBooking and the order cutoff", () => {
  it("after the cutoff, tomorrow: refused before the database call; no booking, no link sent", async () => {
    const e = await refusal(createPayLinkBooking(input("2026-11-12")));
    expect(e.code).toBe("after_cutoff");
    expect(e.message).toBe(
      'After 3:00 PM, a pay-link booking can\'t be delivered tomorrow. Pick Friday, Nov 13 or later, or use "Create unpaid without a pay link" to keep tomorrow.',
    );
    expect(sessionRpc).not.toHaveBeenCalled();
    expect(notifyPayLink).not.toHaveBeenCalled();
  });

  it("after the cutoff, the day after tomorrow: booked and the link sent", async () => {
    const r = await createPayLinkBooking(input("2026-11-13"));
    expect(r.bookingId).toBe("bk-1");
    expect(sessionRpc.mock.calls[0][0]).toBe("staff_create_pay_link_booking");
  });

  it("the floor can't be read: today's rule (tomorrow allowed); the database still enforces the cutoff", async () => {
    floorReply = async () => ({ data: null, error: { code: "57014" } });
    expect((await createPayLinkBooking(input("2026-11-12"))).bookingId).toBe("bk-1");
  });

  it("the database's own after_cutoff refusal reaches staff as after_cutoff", async () => {
    floorReply = async () => ({ data: null, error: { code: "57014" } });
    sessionRpc.mockResolvedValue({
      data: null,
      error: { message: "Delivery date is closed by the 15:00 order cutoff; earliest delivery is 2026-11-13", hint: "after_cutoff", code: "P0001" },
    });
    expect((await refusal(createPayLinkBooking(input("2026-11-12")))).code).toBe("after_cutoff");
  });
});
