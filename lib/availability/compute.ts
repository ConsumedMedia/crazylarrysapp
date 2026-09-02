import type {
  AvailabilityRow,
  AvailabilityDay,
  AvailabilityState,
} from "./types";

/** Standard rental length, in days on site. "Five days on site" per the brand. */
export const DEFAULT_RENTAL_DAYS = 5;

/**
 * Days with this many units free (or fewer) render as the orange "N left"
 * limited state. Mockup shows "1 left"; we widen to <= 2 for urgency runway.
 */
export const LIMITED_MAX = 2;

/**
 * Derive the bookable count + calendar state from the RPC's raw primitives.
 * Pure — no DB, no clock (is_past comes from the DB, computed against
 * current_date + 1 there).
 */
export function deriveDay(row: AvailabilityRow): AvailabilityDay {
  const base = {
    date: row.day,
    total: row.total,
    committed: row.committed,
  };

  if (row.is_past) {
    return { ...base, available: 0, state: "past" };
  }
  if (row.blocked) {
    return { ...base, available: 0, state: "closed" };
  }

  const available = Math.max(0, row.total - row.committed);
  let state: AvailabilityState;
  if (available <= 0) state = "bookedout";
  else if (available <= LIMITED_MAX) state = "limited";
  else state = "open";

  return { ...base, available, state };
}

/** True when a customer can start a rental delivered on this day. */
export function isSelectable(day: AvailabilityDay): boolean {
  return day.state === "open" || day.state === "limited";
}
