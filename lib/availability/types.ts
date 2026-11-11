import type { DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { DeliveryFloor } from "@/lib/bookings/cutoff-shared";

export type { DumpsterSize };

/** Raw per-day primitives from the size_availability RPC. */
export interface AvailabilityRow {
  day: string; // ISO date, yyyy-mm-dd
  total: number;
  committed: number;
  blocked: boolean;
  is_past: boolean;
}

export type AvailabilityState =
  | "open"
  | "limited"
  | "bookedout"
  | "closed"
  | "past";

/** A calendar day with the derived count + state. */
export interface AvailabilityDay {
  date: string; // yyyy-mm-dd
  total: number;
  committed: number;
  available: number;
  state: AvailabilityState;
}

export interface RangeAvailability {
  size: DumpsterSize;
  rentalDays: number;
  days: AvailabilityDay[];
  /**
   * The delivery floor (order cutoff) from the database, added by
   * /api/availability. Calendars that take online orders apply it; the staff
   * phone calendar ignores it. Fallback = today's rule (tomorrow).
   */
  floor?: DeliveryFloor;
}
