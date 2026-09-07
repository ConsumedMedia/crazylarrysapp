import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";
import { geocodeAddress } from "@/lib/geocoding/geocode";
import type { DumpsterSize } from "@/lib/dumpsters/state-machine";

export interface DeployedUnit {
  dumpsterId: string;
  unitNumber: string;
  size: DumpsterSize;
  bookingId: string;
  deliveryAddress: string;
  customerName: string;
  /** null when geocoding hasn't succeeded (yet, or at all) — the unit still
   *  belongs in the on-site list either way, it just has no map pin. */
  lat: number | null;
  lng: number | null;
}

/**
 * Every currently-deployed unit. Available (in-yard) units are never
 * included — there's no real yard-position data to plot them accurately,
 * so they stay a list/count elsewhere, not a pin here.
 *
 * Coordinates are geocoded lazily and cached on the booking row
 * (bookings.delivery_lat/lng) — only bookings missing them get a live
 * Geocoding API call, and only once, ever, per booking. A failed or
 * not-yet-configured geocode still returns the unit (for the on-site list)
 * with lat/lng null — only the *map pin* is conditional on having real
 * coordinates, not the unit's presence in the list.
 */
export async function listDeployedUnits(): Promise<DeployedUnit[]> {
  await requireStaff();
  const supabase = createClient();

  const { data, error } = await supabase
    .from("bookings")
    .select(
      `id, delivery_address, delivery_lat, delivery_lng,
       dumpsters!inner ( id, unit_number, size, status ),
       customers!inner ( full_name )`,
    )
    .eq("dumpsters.status", "deployed")
    .not("status", "in", "(returned,cancelled)");

  if (error) throw new Error(`listDeployedUnits: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    delivery_address: string;
    delivery_lat: number | null;
    delivery_lng: number | null;
    dumpsters: { id: string; unit_number: string; size: DumpsterSize; status: string };
    customers: { full_name: string };
  }>;

  const units: DeployedUnit[] = [];

  for (const row of rows) {
    let lat = row.delivery_lat;
    let lng = row.delivery_lng;

    if (lat === null || lng === null) {
      const geocoded = await geocodeAddress(row.delivery_address);
      if (geocoded) {
        lat = geocoded.lat;
        lng = geocoded.lng;
        // Best-effort cache write — a failure here just means we re-geocode
        // next load, which is inconsequential at this fleet's scale.
        const { error: saveErr } = await supabase
          .from("bookings")
          .update({ delivery_lat: lat, delivery_lng: lng })
          .eq("id", row.id);
        if (saveErr) {
          console.error(`[listDeployedUnits] cache write failed for booking ${row.id}:`, saveErr.message);
        }
      }
    }

    units.push({
      dumpsterId: row.dumpsters.id,
      unitNumber: row.dumpsters.unit_number,
      size: row.dumpsters.size,
      bookingId: row.id,
      deliveryAddress: row.delivery_address,
      customerName: row.customers.full_name,
      lat,
      lng,
    });
  }

  return units;
}
