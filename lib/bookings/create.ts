import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";
import { yardTomorrow } from "@/lib/time/yard";
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

/** RPC params shared by create_booking and staff_create_booking. */
export interface NormalizedBookingParams {
  p_size: CreateBookingInput["size"];
  p_delivery_date: string;
  p_delivery_address: string;
  p_contact_name: string;
  p_rental_days: number;
  p_placement_notes: string | null;
  p_debris_type: string | null;
  p_contact_email: string | null;
  p_contact_phone: string | null;
  p_company_name: string | null;
  p_sms_consent: boolean;
}

/**
 * Type-only brand: `declare` emits nothing, and the class isn't exported, so
 * no other module can name or build one. A private member makes it nominal:
 * an object with a same-named key, or another class with the same private
 * name, doesn't match. Not a unique symbol, on purpose: TypeScript keeps
 * symbol-keyed members through an object spread (so
 * `{ ...params, p_delivery_date: "…" }` would still pass), but drops private
 * members. (Object.assign keeps it; its return type is the intersection.)
 */
declare class ValidatedBookingBrand {
  private readonly validatedByNormalizeBookingInput: true;
}

/**
 * Params that came out of normalizeBookingInput unchanged. The only producer
 * is normalizeBookingInput; a hand-built object or a spread copy is rejected
 * by the compiler. Identical to NormalizedBookingParams at runtime.
 */
export type ValidatedBookingParams = NormalizedBookingParams & ValidatedBookingBrand;

/**
 * Server-side validation for every booking entry point (online /book and the
 * staff manual-booking form). The RPC re-checks the parts that matter for
 * double-booking (date floor, availability) under its lock; this is for
 * clean, specific error messages.
 *
 * Callers see only the first signature, which returns the branded type. The
 * implementation signature below it is the one place the brand is granted:
 * no cast, and nothing at runtime.
 */
export function normalizeBookingInput(input: CreateBookingInput): ValidatedBookingParams;
export function normalizeBookingInput(
  input: CreateBookingInput,
): NormalizedBookingParams {
  if (!isDumpsterSize(input.size)) {
    throw new BookingCreateError("Pick a dumpster size.", "bad_size");
  }
  if (!ISO_DATE.test(input.deliveryDate)) {
    throw new BookingCreateError("Pick a delivery date.", "bad_date");
  }
  if (input.deliveryDate < yardTomorrow()) {
    throw new BookingCreateError(
      "Delivery must be tomorrow or later.",
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

  return {
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
    p_sms_consent: input.smsConsent === true,
  };
}

/**
 * _create_booking_core raises all three date refusals with hint 'unavailable';
 * only the message tells them apart. Pinned against the live function by
 * create-booking-wording.integration.test.ts. A message that matches none of
 * these is never reported as "filled up".
 */
const DATE_REFUSALS: Array<[RegExp, string, string]> = [
  [/^Delivery date must be tomorrow or later/, "past_date", "Delivery must be tomorrow or later."],
  [/^Delivery on \S+ is blocked for /, "blocked", "That date is blocked for this size. Pick another day."],
  [/^No \S+ units available for delivery on /, "unavailable", "That date just filled up for this size. Pick another day."],
];

/** Map a create_booking / staff_create_booking RPC error to a BookingCreateError. */
export function bookingRpcError(
  error: { message: string; code?: string; hint?: string },
  pricingMessage = "Online booking is temporarily unavailable — please call the yard.",
): BookingCreateError {
  const hint = error.hint;
  if (hint === "pricing_not_configured" || hint === "tax_not_configured") {
    return new BookingCreateError(pricingMessage, "pricing_not_configured");
  }
  if (hint === "after_cutoff") {
    // The order cutoff (create_booking / staff_create_pay_link_booking, migration 20261111000000).
    return new BookingCreateError(
      "Orders placed after the cutoff can't be delivered tomorrow. Pick a later day.",
      "after_cutoff",
    );
  }
  if (hint === "unavailable") {
    const match = DATE_REFUSALS.find(([re]) => re.test(error.message));
    if (match) return new BookingCreateError(match[2], match[1]);
    return new BookingCreateError(error.message, "unavailable_unrecognized");
  }
  return new BookingCreateError(error.message, error.code ?? "rpc_failed");
}

/**
 * Create a booking from already-normalized params (payAndBook validates
 * before charging). Accepts only the output of normalizeBookingInput.
 * Resolves the caller's session for profile linkage, then calls the atomic
 * create_booking RPC via the service-role client. Returns the new booking id.
 */
export async function createBooking(
  params: ValidatedBookingParams,
): Promise<{ bookingId: string }> {
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
    ...params,
    p_profile_id: profileId,
  });

  if (error) throw bookingRpcError(error as { message: string; code?: string; hint?: string });

  return { bookingId: data as string };
}
