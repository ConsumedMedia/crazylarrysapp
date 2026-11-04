import { describe, it, expect, vi, afterEach } from "vitest";

const calls: Array<[string, ...unknown[]]> = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => {
      calls.push(["from", t]);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "lte", "not", "order"]) {
        b[op] = (...args: unknown[]) => {
          calls.push([op, ...args]);
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return b;
    },
  }),
}));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ userId: "s", role: "staff" }) }));

import { listUnpaidDue } from "./queries";

afterEach(() => {
  calls.length = 0;
  vi.useRealTimers();
});

describe("listUnpaidDue", () => {
  it("unpaid, open, delivery on or before the YARD's today (11:30 pm New York = still Nov 4)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T04:30:00.000Z"));
    await listUnpaidDue();
    expect(calls).toContainEqual(["from", "bookings"]);
    expect(calls).toContainEqual(["eq", "payment_status", "unpaid"]);
    expect(calls).toContainEqual(["lte", "delivery_date", "2026-11-04"]);
    expect(calls).toContainEqual(["not", "status", "in", "(cancelled,returned)"]);
  });
});
