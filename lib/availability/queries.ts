import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { isDumpsterSize, type DumpsterSize } from "@/lib/dumpsters/state-machine";
import { deriveDay, DEFAULT_RENTAL_DAYS } from "./compute";
import type { AvailabilityRow, AvailabilityDay, RangeAvailability } from "./types";

/**
 * Live per-day availability for a size across [from, to] (inclusive).
 * One RPC call — no caching, reads dumpsters/bookings/calendar_blocks fresh.
 *
 * Uses the service-role client: the customer calendar is anonymous and RLS
 * forbids anon reads of the underlying tables. The data is non-sensitive
 * aggregate capacity — the same numbers shown to customers and staff.
 */
export async function getRangeAvailability(
  size: DumpsterSize,
  from: string,
  to: string,
  rentalDays: number = DEFAULT_RENTAL_DAYS,
): Promise<RangeAvailability> {
  if (!isDumpsterSize(size)) {
    throw new Error(`getRangeAvailability: bad size ${size}`);
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("size_availability", {
    p_size: size,
    p_from: from,
    p_to: to,
    p_rental_days: rentalDays,
  });

  if (error) {
    throw new Error(`size_availability RPC: ${error.message}`);
  }

  const days: AvailabilityDay[] = ((data ?? []) as AvailabilityRow[]).map(
    deriveDay,
  );

  return { size, rentalDays, days };
}

export async function getDayAvailability(
  size: DumpsterSize,
  date: string,
  rentalDays: number = DEFAULT_RENTAL_DAYS,
): Promise<AvailabilityDay> {
  const { days } = await getRangeAvailability(size, date, date, rentalDays);
  if (days.length === 0) {
    throw new Error(`getDayAvailability: no row for ${date}`);
  }
  return days[0];
}
