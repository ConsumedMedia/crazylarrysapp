/**
 * Integration test — hits the linked Supabase project.
 *
 * Opt-in: runs only when CL_RUN_DB_TESTS=1. Needs a staff/owner login because
 * calendar_blocks is staff-only via RLS ("calendar_blocks: staff full
 * access"): SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD (already in .env.local for
 * the demo-seed script).
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/availability/calendar-block-time.integration.test.ts
 *
 * What this verifies against a real Postgres execution of size_availability
 * (not a re-implementation of its logic):
 *   1. A time-scoped block (start_time/end_time set) does NOT flip `blocked`
 *      for a day it covers — proven by comparing size_availability's output
 *      before and after inserting it, for the exact date/size it covers.
 *   2. As a control — so this test can't pass merely because
 *      size_availability ignores calendar_blocks for some unrelated reason —
 *      a full-day block (no time) on a DIFFERENT date in the same run DOES
 *      flip `blocked`, confirming the mechanism is live and the time-scoped
 *      exemption is the actual reason the first block had no effect.
 *   3. The row calendar_blocks actually returns matches what the schedule
 *      grid and dispatch lane banner render from (BlocksPanel.fmtTimeOfDay +
 *      the exact label logic both pages use), i.e. the data + formatting
 *      layer those UIs are built on is correct. (Not a pixel-level browser
 *      check — that would require typing the staff password into a browser
 *      `type` action, which puts it in plaintext in this transcript; skipped
 *      for the same reason the credit-card-fee Settings field was earlier.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const MARKER = `__cb_time_test__${Date.now()}`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ownerEmail = process.env.SEED_OWNER_EMAIL;
const ownerPassword = process.env.SEED_OWNER_PASSWORD;

// Far-future, distinct from other integration tests' fixture dates.
const TIME_BLOCK_DATE = "2027-03-10";
const FULLDAY_BLOCK_DATE = "2027-03-17";
const SIZE = "10yd" as const;

describe.skipIf(!RUN)(
  "calendar_blocks time-of-day — never affects size_availability",
  () => {
    let service: SupabaseClient;
    let staff: SupabaseClient;
    let staffUserId: string;
    const blockIds: string[] = [];

    beforeAll(async () => {
      if (!ownerEmail || !ownerPassword) {
        throw new Error(
          "CL_RUN_DB_TESTS=1 but SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD are not set. " +
            "calendar_blocks needs a staff/owner session (RLS).",
        );
      }
      service = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      staff = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: signInData, error: signInErr } = await staff.auth.signInWithPassword({
        email: ownerEmail,
        password: ownerPassword,
      });
      if (signInErr) throw new Error(`owner sign-in failed: ${signInErr.message}`);
      staffUserId = signInData.user!.id;
    });

    afterAll(async () => {
      if (blockIds.length) {
        const { error } = await service.from("calendar_blocks").delete().in("id", blockIds);
        if (error) console.error("[calendar-block-time cleanup] failed:", error.message);
      }
    });

    async function isBlocked(date: string): Promise<boolean> {
      const { data, error } = await staff.rpc("size_availability", {
        p_size: SIZE,
        p_from: date,
        p_to: date,
        p_rental_days: 5,
      });
      expect(error, error?.message).toBeNull();
      expect(data).toHaveLength(1);
      return data![0].blocked as boolean;
    }

    it("a time-scoped block leaves size_availability.blocked unchanged", async () => {
      expect(await isBlocked(TIME_BLOCK_DATE)).toBe(false);

      const { data: row, error } = await staff
        .from("calendar_blocks")
        .insert({
          size: null, // fleet-wide — same code path as a sized block (`cb.size = p_size or cb.size is null`)
          start_date: TIME_BLOCK_DATE,
          end_date: TIME_BLOCK_DATE,
          start_time: "08:00",
          end_time: "10:00",
          reason: MARKER,
          created_by: staffUserId,
        })
        .select("id, size, start_date, end_date, start_time, end_time, reason")
        .single();
      expect(error, error?.message).toBeNull();
      blockIds.push(row!.id);

      // The real claim: still not blocked, with the block in place.
      expect(await isBlocked(TIME_BLOCK_DATE)).toBe(false);

      // Data layer the schedule grid / dispatch banner render from — confirms
      // the row round-trips with the exact fields + format those UIs use.
      expect(row!.start_time).toBe("08:00:00");
      expect(row!.end_time).toBe("10:00:00");
      const { fmtTimeOfDay } = await import(
        "@/app/(admin)/schedule/_components/BlocksPanel"
      );
      expect(`${fmtTimeOfDay(row!.start_time!)}–${fmtTimeOfDay(row!.end_time!)}`).toBe(
        "8:00 AM–10:00 AM",
      );
    });

    it("control: a full-day block on a different date DOES flip blocked", async () => {
      expect(await isBlocked(FULLDAY_BLOCK_DATE)).toBe(false);

      const { data: row, error } = await staff
        .from("calendar_blocks")
        .insert({
          size: null,
          start_date: FULLDAY_BLOCK_DATE,
          end_date: FULLDAY_BLOCK_DATE,
          reason: MARKER,
          created_by: staffUserId,
        })
        .select("id")
        .single();
      expect(error, error?.message).toBeNull();
      blockIds.push(row!.id);

      expect(await isBlocked(FULLDAY_BLOCK_DATE)).toBe(true);
    });
  },
);
