import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertOwner, assertStaff } from "@/lib/auth/requireStaff";
import {
  DEFAULT_CUTOFF_TIME,
  isAllowedCutoffTime,
  type BookingCutoffInput,
  type BookingCutoffSettings,
} from "./cutoff-settings-shared";

export * from "./cutoff-settings-shared";

/**
 * Order-cutoff settings (cl_booking_settings), read and written on the
 * signed-in person's own session, never service_role: staff read through RLS,
 * only owners can update, and only the two setting columns. updated_by is
 * stamped by the database. The booking paths don't read this; they ask the
 * database for the floor (getDeliveryFloor).
 */

/** The current setting, or null when it can't be read (the panel says so; bookings fall back to tomorrow). */
export async function getBookingCutoffSettings(): Promise<BookingCutoffSettings | null> {
  await assertStaff();
  const { data, error } = await createClient()
    .from("cl_booking_settings")
    .select("cutoff_enabled, cutoff_time, updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  const time = typeof r.cutoff_time === "string" ? r.cutoff_time.slice(0, 5) : DEFAULT_CUTOFF_TIME;
  return {
    cutoff_enabled: r.cutoff_enabled === true,
    cutoff_time: time,
    updated_at: (r.updated_at as string | null) ?? null,
  };
}

export async function saveBookingCutoffSettings(input: BookingCutoffInput): Promise<void> {
  await assertOwner();
  if (!isAllowedCutoffTime(input.cutoff_time)) {
    throw new Error("Pick a cutoff time between 3:00 AM and 11:45 PM, in 15-minute steps.");
  }
  const { data, error } = await createClient()
    .from("cl_booking_settings")
    .update({ cutoff_enabled: input.cutoff_enabled === true, cutoff_time: input.cutoff_time })
    .eq("id", true)
    .select("cutoff_enabled");
  if (error) {
    if (error.code === "23514") throw new Error("Pick a cutoff time between 3:00 AM and 11:45 PM, in 15-minute steps.");
    if (error.code === "42501") throw new Error("Only an owner can change the order cutoff.");
    throw new Error("The order cutoff couldn't be saved. Try again.");
  }
  if (!Array.isArray(data) || data.length !== 1) {
    // RLS let nothing through: not an owner in the database's eyes.
    throw new Error("Only an owner can change the order cutoff.");
  }
}
