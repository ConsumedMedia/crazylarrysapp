/**
 * Timestamps shown to people, in the yard's time zone. Client-safe.
 *
 * Server components render on Vercel, whose clock is UTC, so a formatter with
 * no `timeZone` shows UTC there (a 10:05 AM call reads 2:05 PM, and an evening
 * timestamp lands on the next day). Client components would instead use the
 * viewer's zone, and differ from their own server render. Every timestamp
 * (timestamptz: created_at, paid_at, call times, ...) goes through here.
 *
 * Date-only values (yyyy-mm-dd: delivery_date, pickup_date, ...) are calendar
 * days with no time. They are NOT formatted here: they're parsed as UTC
 * midnight and formatted with timeZone "UTC", so the day never shifts.
 */

/** The yard is in Ohio. Named zone, so daylight saving is handled. */
export const YARD_TIME_ZONE = "America/New_York";

/** Any timestamp in the yard's zone. `timeZone` is always overridden. */
export function formatYardTime(value: string | Date, options: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString("en-US", { ...options, timeZone: YARD_TIME_ZONE });
}

/** "Oct 29, 10:05 AM" */
export function formatYardDateTime(value: string | Date): string {
  return formatYardTime(value, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "10/29/2026": the day a timestamp fell on in the yard. */
export function formatYardDate(value: string | Date): string {
  return formatYardTime(value, { year: "numeric", month: "numeric", day: "numeric" });
}

/*
 * "Today" in the yard. Vercel's clock and the database session are UTC, so
 * new Date().toISOString().slice(0, 10) (or current_date) is already
 * tomorrow from 8 PM EDT / 7 PM EST until midnight. Anything that means "the
 * yard's calendar day" (the delivery floor, today's jobs, a QuickBooks
 * TxnDate, a reminder's "tomorrow") comes from here. The SQL counterpart is
 * public.yard_today().
 */

const YARD_YMD = new Intl.DateTimeFormat("en-US", {
  timeZone: YARD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const YARD_OFFSET = new Intl.DateTimeFormat("en-US", {
  timeZone: YARD_TIME_ZONE,
  timeZoneName: "longOffset",
});

function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The yard's calendar day (yyyy-mm-dd) at a given moment, e.g. a paid_at. */
export function yardDateOf(value: string | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError(`yardDateOf: not a timestamp: ${String(value)}`);
  const p = Object.fromEntries(YARD_YMD.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Today in the yard, yyyy-mm-dd. */
export function yardToday(now: Date = new Date()): string {
  return yardDateOf(now);
}

/** Tomorrow in the yard: the earliest delivery date. */
export function yardTomorrow(now: Date = new Date()): string {
  return addDaysYmd(yardToday(now), 1);
}

/** Minutes the yard is ahead of UTC at `at` (-240 in EDT, -300 in EST). */
function yardOffsetMinutes(at: Date): number {
  const name = YARD_OFFSET.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * The instant the yard's day `ymd` starts (00:00 Eastern), for filtering
 * timestamptz columns by the yard's day. Midnight is never inside a DST
 * jump (those happen at 2 AM), so two passes settle the offset.
 */
export function yardMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - yardOffsetMinutes(new Date(wall)) * 60_000;
  return new Date(wall - yardOffsetMinutes(new Date(first)) * 60_000);
}
