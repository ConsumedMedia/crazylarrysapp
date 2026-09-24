import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import {
  BookingCreateError,
  bookingRpcError,
  normalizeBookingInput,
} from "./create";
import type { CreateBookingInput } from "./types";

/**
 * Staff manual booking (phone / in person). Same validation, pricing gate,
 * advisory lock and availability check as the online path — the RPC shares
 * _create_booking_core with create_booking — but no payment is collected:
 * the booking starts payment_status='unpaid' and is settled later by a cash/
 * check entry or the customer paying the emailed QuickBooks invoice.
 *
 * Runs on the staff member's own session (not service_role) so
 * staff_create_booking's is_staff() guard and auth.uid() audit trail see the
 * real person.
 */
export async function staffCreateBooking(
  input: CreateBookingInput & { customerId?: string | null },
): Promise<{ bookingId: string }> {
  await assertStaff();
  const params = normalizeBookingInput(input);

  const supabase = createClient();
  const { data, error } = await supabase.rpc("staff_create_booking", {
    ...params,
    p_customer_id: input.customerId ?? null,
  });

  if (error) {
    if (error.code === "42501") {
      throw new BookingCreateError(
        "You do not have permission to create bookings.",
        "forbidden",
      );
    }
    throw bookingRpcError(
      error,
      "Pricing isn't configured — enter rates and a tax rate in Settings first.",
    );
  }

  return { bookingId: data as string };
}
