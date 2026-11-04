/**
 * sendBookingInvoice refuses while a pay link is live — before QuickBooks is
 * touched — and reads pay_links by a named column on the staff session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let liveLinks: unknown[] = [];
const selects: Record<string, string> = {};
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const op of ["eq", "limit"]) b[op] = () => b;
      b.select = (cols: string) => {
        selects[t] = cols;
        return b;
      };
      b.maybeSingle = async () =>
        t === "bookings"
          ? { data: { payment_status: "unpaid", status: "confirmed" }, error: null }
          : { data: null, error: null };
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: t === "pay_links" ? liveLinks : [], error: null }).then(res);
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/auth/requireStaff", () => ({ assertStaff: async () => ({ userId: "s", role: "staff" }) }));
const createOrResendBookingInvoice = vi.fn(async () => ({
  qbInvoiceId: "QB-1",
  invoiceLink: null,
  sent: true,
  created: true,
}));
vi.mock("@/lib/quickbooks/invoice-payments", () => ({ createOrResendBookingInvoice }));

import { sendBookingInvoice } from "./mutations";

beforeEach(() => {
  liveLinks = [];
  createOrResendBookingInvoice.mockClear();
});

describe("sendBookingInvoice vs a live pay link", () => {
  it("live link: refused, QuickBooks never called", async () => {
    liveLinks = [{ id: "pl-1" }];
    await expect(sendBookingInvoice("bk-1", "pat@crazylarrys.test")).rejects.toThrow(
      /A pay link is live for this booking, so a QuickBooks invoice isn't available/,
    );
    expect(createOrResendBookingInvoice).not.toHaveBeenCalled();
    expect(selects.pay_links).toBe("id");
  });

  it("no live link: goes ahead as before", async () => {
    await sendBookingInvoice("bk-1", "pat@crazylarrys.test");
    expect(createOrResendBookingInvoice).toHaveBeenCalledTimes(1);
  });
});
