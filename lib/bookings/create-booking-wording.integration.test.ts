/**
 * Pins the live create_booking wording that bookingRpcError relies on. All
 * three date refusals in _create_booking_core carry hint 'unavailable'; only
 * the message tells them apart, so a reworded RAISE would silently turn into
 * the generic message. This drives each refusal for real, as service_role
 * (how payAndBook calls it), inside ONE transaction that is always rolled
 * back, and checks row counts are unchanged afterwards.
 *
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/bookings/create-booking-wording.integration.test.ts
 *
 * The database is shared with production: everything here (a calendar
 * block, throwaway bookings to fill a day) exists only inside the
 * transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { bookingRpcError } from "./create";
import { compensationMessage } from "./checkout";

const RUN = process.env.CL_RUN_DB_TESTS === "1";
const EMAIL = "wording-test@example.com";

type Refusal = { code?: string; message: string; hint?: string };

describe.skipIf(!RUN)("create_booking's date refusals map to past_date / blocked / unavailable (rolled back)", () => {
  let c: Client;
  let countsBefore: Record<string, number>;
  const refusals: Record<string, Refusal> = {};

  const counts = async () =>
    (
      await c.query(
        `select (select count(*) from public.bookings)::int as bookings,
                (select count(*) from public.customers)::int as customers,
                (select count(*) from public.calendar_blocks)::int as calendar_blocks,
                (select count(*) from public.jobs)::int as jobs`,
      )
    ).rows[0] as Record<string, number>;

  /** create_booking as service_role in a savepoint; returns the refusal, or null if it booked. */
  async function book(size: string, date: string): Promise<Refusal | null> {
    await c.query("savepoint attempt");
    await c.query("set local role service_role");
    try {
      await c.query(
        `select public.create_booking($1::dumpster_size, $2::date, '1 Wording Test St, Columbus, OH 43215', 'Wording Test', 5,
                                      null, null, $3, null, null)`,
        [size, date, EMAIL],
      );
      await c.query("reset role");
      await c.query("release savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      await c.query("reset role");
      const err = e as { code?: string; message: string; hint?: string };
      return { code: err.code, message: err.message, hint: err.hint };
    }
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    countsBefore = await counts();
    await c.query("begin");
    try {
      const { today, blockDay, fullDay } = (
        await c.query(
          `select public.yard_today()::text as today, (public.yard_today() + 90)::text as "blockDay",
                  (public.yard_today() + 100)::text as "fullDay"`,
        )
      ).rows[0];

      // 1. the yard's today
      refusals.past = (await book("20yd", today))!;

      // 2. a full-day block on 10yd (any profile can own it; rolled back)
      await c.query(
        `insert into public.calendar_blocks (size, start_date, end_date, reason, created_by)
         select '10yd', $1::date, $1::date, 'wording test (rolled back)', id from public.profiles limit 1`,
        [blockDay],
      );
      refusals.blocked = (await book("10yd", blockDay))!;

      // 3. fill every 20yd unit on one day, then one more
      const { free } = (
        await c.query(
          `select greatest(total - committed, 0)::int as free
           from public.size_availability('20yd'::dumpster_size, $1::date, $1::date, 5)`,
          [fullDay],
        )
      ).rows[0];
      for (let i = 0; i < free; i++) {
        const r = await book("20yd", fullDay);
        if (r) throw new Error(`filling ${fullDay}: booking ${i + 1} of ${free} was refused: ${r.message}`);
      }
      refusals.full = (await book("20yd", fullDay))!;
    } finally {
      await c.query("rollback");
    }
    console.info("live create_booking refusals:", JSON.stringify(refusals));
  });

  afterAll(async () => {
    if (!c) return;
    try {
      expect(await counts()).toEqual(countsBefore);
    } finally {
      await c.end();
    }
  });

  it("the yard's today: real wording maps to past_date", () => {
    expect(refusals.past).toMatchObject({ hint: "unavailable" });
    expect(bookingRpcError(refusals.past).code).toBe("past_date");
  });

  it("a blocked day: real wording maps to blocked", () => {
    expect(refusals.blocked).toMatchObject({ hint: "unavailable" });
    expect(bookingRpcError(refusals.blocked).code).toBe("blocked");
  });

  it("a full day: real wording maps to unavailable, the only 'filled up'", () => {
    expect(refusals.full).toMatchObject({ hint: "unavailable" });
    const e = bookingRpcError(refusals.full);
    expect(e.code).toBe("unavailable");
    expect(compensationMessage(e.code, true)).toMatch(/filled up/);
    expect(compensationMessage(bookingRpcError(refusals.past).code, true)).not.toMatch(/filled up/);
    expect(compensationMessage(bookingRpcError(refusals.blocked).code, true)).not.toMatch(/filled up/);
  });

  it("an unrecognized message with the same hint gets the generic message, never 'filled up'", () => {
    const e = bookingRpcError({ code: "P0001", message: "Some new refusal", hint: "unavailable" });
    for (const refundOk of [true, false]) {
      const msg = compensationMessage(e.code, refundOk);
      expect(msg).toMatch(/^Something went wrong/);
      expect(msg).not.toMatch(/filled up/);
    }
  });

  it("nothing persisted: row counts unchanged after the rollback", async () => {
    expect(await counts()).toEqual(countsBefore);
  });
});
