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
