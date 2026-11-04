"use server";

import { revalidatePath } from "next/cache";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";
import { BookingCreateError } from "@/lib/bookings/create";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";
import { createPayLinkBooking, PayLinkError } from "@/lib/pay-links/staff";
import { scrubPayTokens } from "@/lib/pay-links/contact";
import type { ChannelOutcome } from "@/lib/notifications/notify";

/**
 * Book with a pay link (pay links ON): booking + verbal text consent + link in
 * one transaction, then the link is sent. There is NO redirect: the result
 * stays on this screen, because the only copy of a link that couldn't be sent
 * is `url` here, and it must never ride in a URL.
 */
export interface PayLinkBookingState {
  ok: boolean;
  error?: string;
  bookingId?: string;
  sent?: ChannelOutcome[];
  /** Set only when nothing went out. Shown once; never logged or put in a URL. */
  url?: string | null;
}

function errorState(e: unknown): PayLinkBookingState {
  if (e instanceof NotAuthorizedError || e instanceof PayLinkError || e instanceof BookingCreateError) {
    return { ok: false, error: scrubPayTokens(e.message) };
  }
  // Unknown failures: nothing from the error reaches the screen, and only its
  // scrubbed message reaches the server log.
  console.error("[pay-link booking] failed:", scrubPayTokens(e instanceof Error ? e.message : String(e)));
  return { ok: false, error: "Something went wrong creating the booking. Check the bookings list before trying again." };
}

export async function createPayLinkBookingAction(
  _prev: PayLinkBookingState,
  formData: FormData,
): Promise<PayLinkBookingState> {
  const f = (k: string) => String(formData.get(k) ?? "").trim();
  const size = f("size");
  if (!isDumpsterSize(size)) return { ok: false, error: "Pick a dumpster size." };

  // Same fields, same shaping as createStaffBookingAction.
  const placement = f("placement");
  const notes = f("placementNotes");
  try {
    const r = await createPayLinkBooking({
      size,
      deliveryDate: f("deliveryDate"),
      street: f("street"),
      city: f("city"),
      state: f("state"),
      zip: f("zip"),
      placementNotes: placement ? `Placement: ${placement}${notes ? ` — ${notes}` : ""}` : notes || undefined,
      debrisType: f("debrisType") || undefined,
      contactName: f("contactName"),
      contactEmail: f("contactEmail") || undefined,
      contactPhone: f("contactPhone") || undefined,
      companyName: f("companyName") || undefined,
      smsConsent: formData.get("smsConsent") === "on",
      customerId: f("customerId") || null,
    });
    revalidatePath("/bookings");
    return { ok: true, bookingId: r.bookingId, sent: r.sent, url: r.url };
  } catch (e) {
    return errorState(e);
  }
}
