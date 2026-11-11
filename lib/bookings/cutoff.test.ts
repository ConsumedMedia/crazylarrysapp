/**
 * Unit test: the order-cutoff floor helpers. No database: the service client
 * is a fake. Dates are fictional; the clock is pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let rpcReply: () => Promise<{ data: unknown; error: { code?: string } | null }>;
const rpcCalls: string[] = [];
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: (name: string) => {
      rpcCalls.push(name);
      return rpcReply();
    },
  }),
}));

import { getDeliveryFloor } from "./cutoff";
import {
  cutoffClosedMessage,
  cutoffNote,
  fallbackFloor,
  formatCutoffTime,
  formatDeliveryDay,
  isClosedByCutoff,
  parseFloorRow,
  payLinkCutoffMessage,
  type DeliveryFloor,
} from "./cutoff-shared";

// 4:00 PM Eastern on Wed Nov 11, 2026 (EST, UTC-5).
const NOW = new Date("2026-11-11T21:00:00.000Z");
const ROW = {
  earliest_online: "2026-11-13",
  earliest_staff: "2026-11-12",
  cutoff_enabled: true,
  cutoff_time: "15:00:00",
  after_cutoff: true,
  next_change_at: "2026-11-12T05:00:00+00:00",
};
const AFTER: DeliveryFloor = parseFloorRow(ROW, NOW);

beforeEach(() => {
  rpcCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseFloorRow", () => {
  it("maps the database row", () => {
    expect(AFTER).toEqual({
      earliestOnline: "2026-11-13",
      earliestStaff: "2026-11-12",
      cutoffEnabled: true,
      cutoffTime: "15:00",
      afterCutoff: true,
      nextChangeAt: "2026-11-12T05:00:00.000Z",
      source: "database",
    });
  });

  it.each([
    ["null", null],
    ["no online date", { ...ROW, earliest_online: null }],
    ["bad date", { ...ROW, earliest_online: "Nov 13" }],
    ["online before staff", { ...ROW, earliest_online: "2026-11-11" }],
    ["bad time", { ...ROW, cutoff_time: "3pm" }],
    ["enabled not boolean", { ...ROW, cutoff_enabled: "true" }],
    ["bad next change", { ...ROW, next_change_at: "soon" }],
  ])("%s -> today's rule (tomorrow, no cutoff)", (_label, row) => {
    expect(parseFloorRow(row, NOW)).toEqual(fallbackFloor(NOW));
  });
});

describe("fallbackFloor", () => {
  it("is the yard's tomorrow for everyone, cutoff off, changing at the yard's next midnight", () => {
    expect(fallbackFloor(NOW)).toEqual({
      earliestOnline: "2026-11-12",
      earliestStaff: "2026-11-12",
      cutoffEnabled: false,
      cutoffTime: "15:00",
      afterCutoff: false,
      nextChangeAt: "2026-11-12T05:00:00.000Z",
      source: "fallback",
    });
  });

  it("uses the yard's day, not UTC's: 10 PM Eastern on Nov 11 is still Nov 11", () => {
    expect(fallbackFloor(new Date("2026-11-12T03:00:00Z")).earliestOnline).toBe("2026-11-12");
  });
});

describe("getDeliveryFloor (fails safe to tomorrow)", () => {
  it("returns the database answer", async () => {
    rpcReply = async () => ({ data: [ROW], error: null });
    expect(await getDeliveryFloor(NOW)).toEqual(AFTER);
    expect(rpcCalls).toEqual(["booking_delivery_floor"]);
  });

  it("an RPC error -> tomorrow (fallback)", async () => {
    rpcReply = async () => ({ data: null, error: { code: "42883" } });
    expect(await getDeliveryFloor(NOW)).toEqual(fallbackFloor(NOW));
  });

  it("the client throwing -> tomorrow (fallback), never throws", async () => {
    rpcReply = () => Promise.reject(new Error("fetch failed"));
    expect(await getDeliveryFloor(NOW)).toEqual(fallbackFloor(NOW));
  });

  it("a malformed row -> tomorrow (fallback)", async () => {
    rpcReply = async () => ({ data: [{ nope: 1 }], error: null });
    expect((await getDeliveryFloor(NOW)).source).toBe("fallback");
  });
});

describe("isClosedByCutoff", () => {
  it("closes only the days between the staff floor and the online floor", () => {
    expect(isClosedByCutoff("2026-11-11", AFTER)).toBe(false); // before tomorrow: the tomorrow rule's business
    expect(isClosedByCutoff("2026-11-12", AFTER)).toBe(true);
    expect(isClosedByCutoff("2026-11-13", AFTER)).toBe(false);
    expect(isClosedByCutoff("2026-11-12", fallbackFloor(NOW))).toBe(false);
  });
});

describe("wording", () => {
  it("times and days", () => {
    expect(["03:00", "11:45", "12:00", "15:00", "23:45"].map(formatCutoffTime)).toEqual(["3:00 AM", "11:45 AM", "12:00 PM", "3:00 PM", "11:45 PM"]);
    expect(formatDeliveryDay("2026-11-13")).toBe("Friday, Nov 13");
  });

  it("the calendar note shows only while the cutoff is on", () => {
    expect(cutoffNote(AFTER)).toBe("Orders placed after 3:00 PM Eastern are delivered from the day after tomorrow.");
    expect(cutoffNote(fallbackFloor(NOW))).toBeNull();
  });

  it("customer and staff messages name the time and the earliest day; the customer one says not charged", () => {
    expect(cutoffClosedMessage(AFTER)).toBe(
      "It's past 3:00 PM Eastern, so tomorrow is no longer available. The earliest delivery is Friday, Nov 13. You have not been charged.",
    );
    expect(payLinkCutoffMessage(AFTER)).toBe(
      'After 3:00 PM, a pay-link booking can\'t be delivered tomorrow. Pick Friday, Nov 13 or later, or use "Create unpaid without a pay link" to keep tomorrow.',
    );
  });
});
