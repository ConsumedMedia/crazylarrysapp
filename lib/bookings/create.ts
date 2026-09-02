import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";
import { tomorrowYmd } from "@/lib/availability/dates";
import { DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import type { CreateBookingInput } from "./types";

export class BookingCreateError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "BookingCreateError";
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function clean(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

/**
 * Create a booking. Validates everything server-side, resolves the caller's
 * session for profile linkage, then calls the atomic create_booking RPC via
 * the service-role client. Returns the new booking id.
 */
export async function createBooking(
  input: CreateBookingInput,
): Promise<{ bookingId: string }> {
  // ---- validate ----------------------------------------------------------
  if (!isDumpsterSize(input.size)) {
    throw new BookingCreateError("Pick a dumpster size.", "bad_size");
  }
  if (!ISO_DATE.test(input.deliveryDate)) {
    throw new BookingCreateError("Pick a delivery date.", "bad_date");
  }
  if (input.deliveryDate < tomorrowYmd()) {
    throw new BookingCreateError(
      "The earliest delivery is tomorrow.",
      "past_date",
    );
  }
  const rentalDays = input.rentalDays ?? DEFAULT_RENTAL_DAYS;
  if (!Number.isInteger(rentalDays) || rentalDays < 1 || rentalDays > 60) {
    throw new BookingCreateError("Invalid rental length.", "bad_rental");
  }

  const street = clean(input.street);
  const city = clean(input.city);
  const stateAbbr = clean(input.state);
  const zip = clean(input.zip);
  if (!street || !city || !stateAbbr || !zip) {
    throw new BookingCreateError(
      "A full delivery address is required.",
      "bad_address",
    );
  }
  const address = `${street}, ${city}, ${stateAbbr} ${zip}`;

  const contactName = clean(input.contactName);
  if (!contactName) {
    throw new BookingCreateError("A contact name is required.", "bad_contact");
  }
  const email = clean(input.contactEmail);
  const phone = clean(input.contactPhone);
  if (!email && !phone) {
    throw new BookingCreateError(
      "Add an email or a phone number so we can reach you.",
      "no_contact",
    );
  }
  if (email && !EMAIL.test(email)) {
    throw new BookingCreateError("That email doesn't look right.", "bad_email");
  }

  // ---- session -> profile linkage --------------------------------------
  let profileId: string | null = null;
  try {
    const sessionClient = createClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();
    profileId = user?.id ?? null;
  } catch {
    profileId = null;
  }

  // ---- atomic RPC -----------------------------------------------------
  const service = createServiceClient();
  const { data, error } = await service.rpc("create_booking", {
    p_size: input.size,
    p_delivery_date: input.deliveryDate,
    p_delivery_address: address,
    p_contact_name: contactName,
    p_rental_days: rentalDays,
    p_placement_notes: clean(input.placementNotes),
    p_debris_type: clean(input.debrisType),
    p_contact_email: email,
    p_contact_phone: phone,
    p_company_name: clean(input.companyName),
    p_profile_id: profileId,
  });

  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === "pricing_not_configured" || hint === "tax_not_configured") {
      throw new BookingCreateError(
        "Online booking is temporarily unavailable — please call the yard.",
        "pricing_not_configured",
      );
    }
    if (hint === "unavailable") {
      throw new BookingCreateError(
        "That date just filled up for this size. Pick another day.",
        "unavailable",
      );
    }
    throw new BookingCreateError(error.message, error.code ?? "rpc_failed");
  }

  return { bookingId: data as string };
}
