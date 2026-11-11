import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { fallbackFloor, parseFloorRow, type DeliveryFloor } from "./cutoff-shared";

export * from "./cutoff-shared";

/**
 * The delivery floor from the database (public.booking_delivery_floor,
 * service_role only), the same function the database itself enforces with.
 *
 * Fails safe to today's rule: if the call errors, throws or returns something
 * malformed, the answer is "tomorrow, no cutoff" (source "fallback"). The
 * database still enforces the real rule, with a 10-minute grace.
 */
export async function getDeliveryFloor(now: Date = new Date()): Promise<DeliveryFloor> {
  try {
    const { data, error } = await createServiceClient().rpc("booking_delivery_floor");
    if (error) {
      console.warn("[cutoff] booking_delivery_floor unavailable, using tomorrow:", error.code ?? "error");
      return fallbackFloor(now);
    }
    return parseFloorRow(Array.isArray(data) ? data[0] : data, now);
  } catch {
    console.warn("[cutoff] booking_delivery_floor threw, using tomorrow");
    return fallbackFloor(now);
  }
}
