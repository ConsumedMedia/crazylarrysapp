import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import {
  BookingCreateError,
  bookingRpcError,
  normalizeBookingInput,
} from "@/lib/bookings/create";
import { notifyPayLink } from "@/lib/notifications/notify";
import { payLinkTokenKey } from "./token";
import type { CreateBookingInput } from "@/lib/bookings/types";

/**
 * Staff side of pay links. Runs on the staff member's own session (never
 * service_role) so the RPCs' is_staff() guard and auth.uid() audit trail see
 * the real person — same rule as staffCreateBooking.
 */

export class PayLinkError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "PayLinkError";
    this.code = code;
  }
}

/** Hints raised by the pay-link RPCs, in staff words. */
const HINTS: Record<string, string> = {
  pay_links_disabled: "Pay links are turned off in Settings.",
  no_reachable_contact:
    "Add an email, or a phone number and tick that the customer agreed to texts — otherwise we can't send the pay link.",
  not_unpaid: "This booking isn't unpaid, so it can't get a pay link.",
  not_open: "This booking is closed, so it can't get a pay link.",
  qbo_invoice_pending:
    "A QuickBooks invoice is still open for this booking. Void it in QuickBooks first, then send the pay link.",
};

function rpcError(error: { message: string; code?: string; hint?: string }): Error {
  if (error.code === "42501") return new PayLinkError("You do not have permission to do that.", "forbidden");
  if (error.hint && HINTS[error.hint]) return new PayLinkError(HINTS[error.hint], error.hint);
  return new PayLinkError(error.message, error.code ?? "rpc_failed");
}

/**
 * The stored-copy key goes to the RPC only when it is set, so with no key the
 * call is exactly the one-argument form (the link works; reminders for it
 * can't carry it until a Resend after the key is set).
 */
function keyParam(): { p_token_key?: string } {
  const key = payLinkTokenKey();
  return key ? { p_token_key: key } : {};
}

/**
 * The contact rule, checked before the database is touched (the RPC checks it
 * again): an email, or a phone with the customer's verbal OK to texts.
 */
export function reachable(input: { contactEmail?: string; contactPhone?: string; smsConsent?: boolean }): boolean {
  const email = (input.contactEmail ?? "").trim();
  const phone = (input.contactPhone ?? "").trim();
  return email.length > 0 || (phone.length > 0 && input.smsConsent === true);
}

/**
 * Book with a pay link: booking + verbal-consent record + link in one
 * transaction (staff_create_pay_link_booking), then send the link. The send
 * never throws; its outcome is in notifications_log for the booking page.
 */
export async function createPayLinkBooking(
  input: CreateBookingInput & { customerId?: string | null },
): Promise<{ bookingId: string }> {
  await assertStaff();
  if (!reachable(input)) throw new PayLinkError(HINTS.no_reachable_contact, "no_reachable_contact");
  const params = normalizeBookingInput(input);

  const supabase = createClient();
  const { data, error } = await supabase.rpc("staff_create_pay_link_booking", {
    p_size: params.p_size,
    p_delivery_date: params.p_delivery_date,
    p_delivery_address: params.p_delivery_address,
    p_contact_name: params.p_contact_name,
    p_rental_days: params.p_rental_days,
    p_placement_notes: params.p_placement_notes,
    p_debris_type: params.p_debris_type,
    p_contact_email: params.p_contact_email,
    p_contact_phone: params.p_contact_phone,
    p_company_name: params.p_company_name,
    p_verbal_sms_consent: params.p_sms_consent,
    p_customer_id: input.customerId ?? null,
    ...keyParam(),
  });
  if (error) {
    const e = error as { message: string; code?: string; hint?: string };
    if (e.hint && HINTS[e.hint]) throw rpcError(e);
    if (e.code === "42501") throw rpcError(e);
    // Date / capacity / pricing refusals come from _create_booking_core.
    throw bookingRpcError(e, "Pricing isn't configured — enter rates and a tax rate in Settings first.");
  }
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; token: string } | null;
  if (!row?.booking_id || !row.token) {
    throw new BookingCreateError("The booking didn't come back from the database.", "rpc_failed");
  }

  await notifyPayLink(row.booking_id, row.token, "pay_link");
  return { bookingId: row.booking_id };
}

/** Resend: a new link replaces the old one (dead in the same transaction), then send it. */
export async function resendPayLink(bookingId: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("issue_pay_link", { p_booking_id: bookingId, ...keyParam() });
  if (error) throw rpcError(error as { message: string; code?: string; hint?: string });
  await notifyPayLink(bookingId, data as string, "pay_link");
}
