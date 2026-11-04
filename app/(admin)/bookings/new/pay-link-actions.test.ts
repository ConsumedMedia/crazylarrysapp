/**
 * The Book action's own guard, independent of the library's: whatever error
 * comes up from below, what reaches the screen has no token in it, and an
 * unknown error shows a generic message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
let thrown: unknown = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/requireStaff", () => ({ NotAuthorizedError: class NotAuthorizedError extends Error {} }));
vi.mock("@/lib/pay-links/staff", async () => {
  const { PayLinkError } = await vi.importActual<typeof import("@/lib/pay-links/staff")>("@/lib/pay-links/staff");
  return {
    PayLinkError,
    createPayLinkBooking: async () => {
      throw thrown;
    },
  };
});

const form = () => {
  const fd = new FormData();
  fd.set("size", "15yd");
  return fd;
};

beforeEach(() => {
  thrown = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createPayLinkBookingAction error guard", () => {
  it("PayLinkError carrying a token: shown scrubbed", async () => {
    const { PayLinkError } = await import("@/lib/pay-links/staff");
    thrown = new PayLinkError(`refused near /pay/${TOKEN}`, "x");
    const { createPayLinkBookingAction } = await import("./pay-link-actions");
    const s = await createPayLinkBookingAction({ ok: false }, form());
    expect(s.error).toBe("refused near /pay/…");
  });

  it("BookingCreateError carrying a bare token: shown scrubbed", async () => {
    const { BookingCreateError } = await import("@/lib/bookings/create");
    thrown = new BookingCreateError(`date refused ${TOKEN} ok`, "x");
    const { createPayLinkBookingAction } = await import("./pay-link-actions");
    const s = await createPayLinkBookingAction({ ok: false }, form());
    expect(s.error).toBe("date refused … ok");
  });

  it("unknown error: generic message on screen, scrubbed text in the server log only", async () => {
    thrown = new Error(`kaboom ${TOKEN}`);
    const { createPayLinkBookingAction } = await import("./pay-link-actions");
    const s = await createPayLinkBookingAction({ ok: false }, form());
    expect(s.error).toMatch(/Check the bookings list/);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).toContain("kaboom");
    expect(logged).not.toContain(TOKEN);
  });
});
