/**
 * Unit test: order-cutoff settings, read and saved through a fake session
 * client (never service_role). The database's own limits and RLS are proven
 * by scripts/probe-booking-cutoff.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ op: string; payload?: unknown }> = [];
let selectReply: { data: unknown; error: { code?: string } | null };
let updateReply: { data: unknown; error: { code?: string } | null };
const assertOwner = vi.fn(async () => ({ userId: "owner-1", role: "owner" }));
const assertStaff = vi.fn(async () => ({ userId: "staff-1", role: "staff" }));

vi.mock("@/lib/auth/requireStaff", () => ({ assertOwner: () => assertOwner(), assertStaff: () => assertStaff() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      calls.push({ op: `from ${table}` });
      const chain = {
        select: (cols: string) => {
          calls.push({ op: "select", payload: cols });
          return chain;
        },
        update: (payload: unknown) => {
          calls.push({ op: "update", payload });
          return { eq: () => ({ select: async () => updateReply }) };
        },
        eq: () => chain,
        maybeSingle: async () => selectReply,
      };
      return chain;
    },
  }),
}));

import {
  CUTOFF_TIMES,
  getBookingCutoffSettings,
  parseCutoffSettingsForm,
  saveBookingCutoffSettings,
} from "./cutoff-settings";

beforeEach(() => {
  calls.length = 0;
  assertOwner.mockClear();
  assertStaff.mockClear();
  selectReply = { data: { cutoff_enabled: false, cutoff_time: "15:00:00", updated_at: null }, error: null };
  updateReply = { data: [{ cutoff_enabled: true }], error: null };
});

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("the time grid", () => {
  it("is 03:00 to 23:45 in 15-minute steps", () => {
    expect(CUTOFF_TIMES).toHaveLength(84);
    expect(CUTOFF_TIMES.slice(0, 2)).toEqual(["03:00", "03:15"]);
    expect(CUTOFF_TIMES.at(-1)).toBe("23:45");
    expect(CUTOFF_TIMES.every((t) => /^(0[3-9]|1\d|2[0-3]):(00|15|30|45)$/.test(t))).toBe(true);
  });
});

describe("parseCutoffSettingsForm", () => {
  it("on/off from the checkbox, the time from the picker", () => {
    expect(parseCutoffSettingsForm(fd({ cutoff_enabled: "on", cutoff_time: "15:00" }))).toEqual({
      ok: true,
      value: { cutoff_enabled: true, cutoff_time: "15:00" },
    });
    expect(parseCutoffSettingsForm(fd({ cutoff_time: "17:30" }))).toEqual({
      ok: true,
      value: { cutoff_enabled: false, cutoff_time: "17:30" },
    });
  });

  it.each(["02:45", "15:10", "23:50", "24:00", "15:00:30", "", "3pm"])("refuses %j", (t) => {
    expect(parseCutoffSettingsForm(fd({ cutoff_enabled: "on", cutoff_time: t })).ok).toBe(false);
  });
});

describe("getBookingCutoffSettings", () => {
  it("staff session; the database's HH:MM:SS shown as HH:MM", async () => {
    expect(await getBookingCutoffSettings()).toEqual({ cutoff_enabled: false, cutoff_time: "15:00", updated_at: null });
    expect(assertStaff).toHaveBeenCalled();
    expect(calls[0]).toEqual({ op: "from cl_booking_settings" });
  });

  it("unreadable (error or no row) -> null", async () => {
    selectReply = { data: null, error: { code: "42501" } };
    expect(await getBookingCutoffSettings()).toBeNull();
    selectReply = { data: null, error: null };
    expect(await getBookingCutoffSettings()).toBeNull();
  });
});

describe("saveBookingCutoffSettings", () => {
  it("owner only; writes exactly the two setting columns (updated_by is stamped by the database)", async () => {
    await saveBookingCutoffSettings({ cutoff_enabled: true, cutoff_time: "15:00" });
    expect(assertOwner).toHaveBeenCalled();
    expect(calls.find((c) => c.op === "update")?.payload).toEqual({ cutoff_enabled: true, cutoff_time: "15:00" });
  });

  it("refuses a time off the grid before touching the database", async () => {
    await expect(saveBookingCutoffSettings({ cutoff_enabled: true, cutoff_time: "15:10" })).rejects.toThrow(/15-minute steps/);
    expect(calls).toEqual([]);
  });

  it("RLS letting nothing through (0 rows) is reported as owner-only, not as saved", async () => {
    updateReply = { data: [], error: null };
    await expect(saveBookingCutoffSettings({ cutoff_enabled: true, cutoff_time: "15:00" })).rejects.toThrow(
      "Only an owner can change the order cutoff.",
    );
  });

  it("database refusals in plain words", async () => {
    updateReply = { data: null, error: { code: "23514" } };
    await expect(saveBookingCutoffSettings({ cutoff_enabled: true, cutoff_time: "15:00" })).rejects.toThrow(/15-minute steps/);
    updateReply = { data: null, error: { code: "42501" } };
    await expect(saveBookingCutoffSettings({ cutoff_enabled: true, cutoff_time: "15:00" })).rejects.toThrow("Only an owner");
  });

  it("a non-owner never reaches the database", async () => {
    assertOwner.mockRejectedValueOnce(new Error("Owner only"));
    await expect(saveBookingCutoffSettings({ cutoff_enabled: true, cutoff_time: "15:00" })).rejects.toThrow("Owner only");
    expect(calls).toEqual([]);
  });
});
