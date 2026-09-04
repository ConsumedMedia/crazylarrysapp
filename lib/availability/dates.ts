/**
 * Pure UTC date helpers for the availability calendars. Client-safe (no
 * "server-only"). All dates are yyyy-mm-dd strings; Date objects are UTC.
 */

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface MonthGridCell {
  date: string; // yyyy-mm-dd
  dayOfMonth: number;
  inMonth: boolean; // false for lead/trail days from adjacent months
}

/**
 * The 6-week (42-cell), Sunday-first grid for the month containing `anchor`.
 */
export function monthGrid(anchor: Date): {
  year: number;
  month: number; // 0-11
  from: string;
  to: string;
  cells: MonthGridCell[];
} {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());

  const cells: MonthGridCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    cells.push({
      date: ymd(d),
      dayOfMonth: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month,
    });
  }

  return {
    year,
    month,
    from: cells[0].date,
    to: cells[41].date,
    cells,
  };
}

/** The days a rental occupies: [delivery, delivery+rentalDays-1]. */
export function rentalWindow(delivery: string, rentalDays: number): string[] {
  return Array.from({ length: rentalDays }, (_, i) => addDays(delivery, i));
}

/** Tomorrow (UTC), the earliest selectable delivery date. */
export function tomorrowYmd(now = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

/** Today (UTC) as yyyy-mm-dd. */
export function todayYmd(now = new Date()): string {
  return ymd(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
  );
}
