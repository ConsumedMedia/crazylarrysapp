/**
 * Order cutoff: types and pure helpers, safe on the client.
 *
 * The rule lives in the database (public.booking_delivery_floor, migration
 * 20261111000000). The server reads it with getDeliveryFloor (cutoff.ts) and
 * passes the answer around as a DeliveryFloor; nothing here computes the rule
 * itself except the fail-safe fallback, which is today's "tomorrow" floor.
 */
import { yardMidnight, yardTomorrow } from "@/lib/time/yard";

export interface DeliveryFloor {
  /** Earliest delivery day for online and pay-link bookings, yyyy-mm-dd. */
  earliestOnline: string;
  /** Earliest delivery day for staff phone bookings (always the yard's tomorrow). */
  earliestStaff: string;
  cutoffEnabled: boolean;
  /** Yard time of day, "HH:MM". */
  cutoffTime: string;
  afterCutoff: boolean;
  /** ISO instant the floor next changes (today's cutoff, or the next yard midnight). */
  nextChangeAt: string;
  /** "fallback" = the database answer couldn't be read; today's rule (tomorrow) is used. */
  source: "database" | "fallback";
}

/** The database judges the cutoff as of this many minutes ago (see the migration). Display/tests only. */
export const CUTOFF_GRACE_MINUTES = 10;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/** Today's rule: tomorrow for everyone, no cutoff. Used whenever the database answer is unavailable. */
export function fallbackFloor(now: Date = new Date()): DeliveryFloor {
  const tomorrow = yardTomorrow(now);
  return {
    earliestOnline: tomorrow,
    earliestStaff: tomorrow,
    cutoffEnabled: false,
    cutoffTime: "15:00",
    afterCutoff: false,
    nextChangeAt: yardMidnight(tomorrow).toISOString(),
    source: "fallback",
  };
}

/** One row of booking_delivery_floor() as PostgREST returns it; anything malformed falls back. */
export function parseFloorRow(row: unknown, now: Date = new Date()): DeliveryFloor {
  if (!row || typeof row !== "object") return fallbackFloor(now);
  const r = row as Record<string, unknown>;
  const online = r.earliest_online;
  const staff = r.earliest_staff;
  const time = typeof r.cutoff_time === "string" ? HHMM.exec(r.cutoff_time) : null;
  const next = typeof r.next_change_at === "string" ? Date.parse(r.next_change_at) : NaN;
  if (
    typeof online !== "string" || !YMD.test(online) ||
    typeof staff !== "string" || !YMD.test(staff) ||
    online < staff ||
    typeof r.cutoff_enabled !== "boolean" || typeof r.after_cutoff !== "boolean" ||
    !time || !Number.isFinite(next)
  ) {
    return fallbackFloor(now);
  }
  return {
    earliestOnline: online,
    earliestStaff: staff,
    cutoffEnabled: r.cutoff_enabled,
    cutoffTime: `${time[1]}:${time[2]}`,
    afterCutoff: r.after_cutoff,
    nextChangeAt: new Date(next).toISOString(),
    source: "database",
  };
}

/** A day the cutoff has closed for online and pay-link bookings (open to staff phone bookings). */
export function isClosedByCutoff(date: string, floor: DeliveryFloor): boolean {
  return date >= floor.earliestStaff && date < floor.earliestOnline;
}

/** "15:00" -> "3:00 PM". */
export function formatCutoffTime(hhmm: string): string {
  const m = HHMM.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

/** "2026-11-13" -> "Friday, Nov 13" (a calendar date, so formatted in UTC). */
export function formatDeliveryDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return DAY.format(new Date(Date.UTC(y, m - 1, d)));
}

/** The line under the customer calendar while the cutoff is on. */
export function cutoffNote(floor: DeliveryFloor): string | null {
  if (!floor.cutoffEnabled) return null;
  return `Orders placed after ${formatCutoffTime(floor.cutoffTime)} Eastern are delivered from the day after tomorrow.`;
}

/** A customer's picked day was closed by the cutoff (calendar refresh, or checkout step 0). */
export function cutoffClosedMessage(floor: DeliveryFloor): string {
  return `It's past ${formatCutoffTime(floor.cutoffTime)} Eastern, so tomorrow is no longer available. The earliest delivery is ${formatDeliveryDay(floor.earliestOnline)}. You have not been charged.`;
}

/** Staff, pay-link button or server action: the day is closed for a pay-link booking. */
export function payLinkCutoffMessage(floor: DeliveryFloor): string {
  return `After ${formatCutoffTime(floor.cutoffTime)}, a pay-link booking can't be delivered tomorrow. Pick ${formatDeliveryDay(floor.earliestOnline)} or later, or use "Create unpaid without a pay link" to keep tomorrow.`;
}
