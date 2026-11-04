import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<[string, ...unknown[]]> = [];
let rows: unknown[] = [];
let rpcError: { code: string; message: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (t: string) => {
      calls.push(["from", t]);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "order"]) {
        b[op] = (...args: unknown[]) => {
          calls.push([op, ...args]);
          return b;
        };
      }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
      return b;
    },
    rpc: async (name: string, args: unknown) => {
      calls.push(["rpc", name, args]);
      return { data: null, error: rpcError };
    },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    throw new Error("service_role must not be used here");
  },
}));
vi.mock("@/lib/auth/requireStaff", () => ({ assertStaff: async () => ({ userId: "s", role: "staff" }) }));

import { listFailedRefunds, resolveFailedRefund } from "./failed-refunds";

beforeEach(() => {
  calls.length = 0;
  rows = [];
  rpcError = null;
});

describe("listFailedRefunds (staff session)", () => {
  it("only unresolved compensating refunds whose refund FAILED", async () => {
    await listFailedRefunds();
    expect(calls).toContainEqual(["from", "payment_attempts"]);
    expect(calls).toContainEqual(["eq", "kind", "compensating_refund"]);
    expect(calls).toContainEqual(["is", "resolved_at", null]);
    expect(calls).toContainEqual(["eq", "context->>refund_succeeded", "false"]);
  });

  it("maps a pay-link failure (with booking) and a checkout failure (without)", async () => {
    rows = [
      { id: "a1", created_at: "2026-11-04T15:00:00Z", amount: "375.38", qb_charge_id: "CH-1", reason: "booking changed", context: { booking_id: "bk-1", refund_succeeded: false } },
      { id: "a2", created_at: "2026-11-03T15:00:00Z", amount: null, qb_charge_id: null, reason: null, context: { refund_succeeded: false } },
    ];
    expect(await listFailedRefunds()).toEqual([
      { id: "a1", createdAt: "2026-11-04T15:00:00Z", amount: 375.38, chargeId: "CH-1", reason: "booking changed", bookingId: "bk-1", source: "pay_link" },
      { id: "a2", createdAt: "2026-11-03T15:00:00Z", amount: null, chargeId: null, reason: null, bookingId: null, source: "checkout" },
    ]);
  });
});

describe("resolveFailedRefund", () => {
  it("calls resolve_payment_attempt on the session (the RPC records who and when)", async () => {
    await resolveFailedRefund("a1");
    expect(calls).toContainEqual(["rpc", "resolve_payment_attempt", { p_attempt_id: "a1" }]);
  });
  it("already resolved reads plainly", async () => {
    rpcError = { code: "P0002", message: "Nothing to resolve" };
    await expect(resolveFailedRefund("a1")).rejects.toThrow(/Already resolved/);
  });
});
