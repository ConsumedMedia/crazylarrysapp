"use server";

import { createBooking, BookingCreateError } from "@/lib/bookings/create";
import type { CreateBookingInput } from "@/lib/bookings/types";

export interface CreateBookingResult {
  ok: boolean;
  bookingId?: string;
  error?: string;
  code?: string;
}

export async function createBookingAction(
  input: CreateBookingInput & { agreementAcknowledged: boolean },
): Promise<CreateBookingResult> {
  if (!input.agreementAcknowledged) {
    return {
      ok: false,
      error: "Please open and complete the rental agreement first.",
      code: "agreement",
    };
  }
  try {
    const { bookingId } = await createBooking(input);
    return { ok: true, bookingId };
  } catch (e) {
    if (e instanceof BookingCreateError) {
      return { ok: false, error: e.message, code: e.code };
    }
    console.error("[createBookingAction]", e);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}
