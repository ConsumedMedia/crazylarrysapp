import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireCustomer, assertCustomer } from "@/lib/auth/requireCustomer";
import { assertStaff } from "@/lib/auth/requireStaff";

export class ChangeRequestError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "ChangeRequestError";
    this.code = code;
  }
}

export type ChangeRequestStatus = "pending" | "approved" | "declined" | "cancelled";

export interface ChangeRequestRow {
  id: string;
  booking_id: string;
  requested_delivery_date: string | null;
  requested_pickup_date: string | null;
  reason: string;
  status: ChangeRequestStatus;
  staff_response: string | null;
  created_at: string;
  resolved_at: string | null;
}

const REQUEST_COLS =
  "id, booking_id, requested_delivery_date, requested_pickup_date, reason, status, staff_response, created_at, resolved_at";

// Terminal booking states where a further change request doesn't make sense.
const NON_REQUESTABLE_STATUSES = new Set(["returned", "cancelled"]);

export interface MyPendingChangeRequestRow extends ChangeRequestRow {
  booking_delivery_address: string;
  booking_delivery_date: string;
  booking_pickup_date: string | null;
}

/**
 * The signed-in customer's own pending requests, across all their bookings —
 * for the account dashboard banner. RLS ("booking_change_requests: customer
 * reads own") already scopes this to their own via the booking->customer
 * join, so no manual filter is needed beyond status.
 */
export async function listMyPendingChangeRequests(): Promise<MyPendingChangeRequestRow[]> {
  await requireCustomer();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("booking_change_requests")
    .select(`${REQUEST_COLS}, bookings(delivery_address, delivery_date, pickup_date)`)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listMyPendingChangeRequests: ${error.message}`);

  return (data ?? []).map((r: Record<string, unknown>) => {
    const booking = r.bookings as
      | { delivery_address: string; delivery_date: string; pickup_date: string | null }
      | null;
    return {
      id: r.id as string,
      booking_id: r.booking_id as string,
      requested_delivery_date: r.requested_delivery_date as string | null,
      requested_pickup_date: r.requested_pickup_date as string | null,
      reason: r.reason as string,
      status: r.status as ChangeRequestStatus,
      staff_response: r.staff_response as string | null,
      created_at: r.created_at as string,
      resolved_at: r.resolved_at as string | null,
      booking_delivery_address: booking?.delivery_address ?? "",
      booking_delivery_date: booking?.delivery_date ?? "",
      booking_pickup_date: booking?.pickup_date ?? null,
    };
  });
}

/**
 * Requests for one booking. RLS covers both callers: staff see everything,
 * a customer only sees rows on a booking that's theirs — so this can be
 * called from either the customer or admin booking-detail page unchanged.
 */
export async function listChangeRequestsForBooking(
  bookingId: string,
): Promise<ChangeRequestRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("booking_change_requests")
    .select(REQUEST_COLS)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listChangeRequestsForBooking: ${error.message}`);
  return (data ?? []) as ChangeRequestRow[];
}

export async function createChangeRequest(input: {
  bookingId: string;
  requestedDeliveryDate?: string | null;
  requestedPickupDate?: string | null;
  reason: string;
}): Promise<void> {
  const ctx = await requireCustomer();

  if (!input.requestedDeliveryDate && !input.requestedPickupDate) {
    throw new ChangeRequestError(
      "Choose a new delivery date, pickup date, or both.",
      "no_change",
    );
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new ChangeRequestError("Tell us why you need the change.", "no_reason");
  }

  const supabase = createClient();

  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id, status")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (bookingErr) throw new ChangeRequestError(bookingErr.message, "booking_read");
  if (!booking) {
    throw new ChangeRequestError("That booking no longer exists.", "not_found");
  }
  if (NON_REQUESTABLE_STATUSES.has(booking.status as string)) {
    throw new ChangeRequestError(
      "This booking is already closed out — no changes can be requested.",
      "closed",
    );
  }

  const { data: existingPending } = await supabase
    .from("booking_change_requests")
    .select("id")
    .eq("booking_id", input.bookingId)
    .eq("status", "pending")
    .maybeSingle();
  if (existingPending) {
    throw new ChangeRequestError(
      "You already have a pending request on this booking — wait for a response before submitting another.",
      "duplicate",
    );
  }

  const { error } = await supabase.from("booking_change_requests").insert({
    booking_id: input.bookingId,
    requested_by: ctx.userId,
    requested_delivery_date: input.requestedDeliveryDate ?? null,
    requested_pickup_date: input.requestedPickupDate ?? null,
    reason,
  });
  if (error) {
    if (error.code === "42501") {
      throw new ChangeRequestError(
        "You can only request changes on your own bookings.",
        "forbidden",
      );
    }
    throw new ChangeRequestError(error.message, error.code ?? "insert_failed");
  }
}

/** Customer withdraws their own still-pending request. */
export async function cancelChangeRequest(id: string): Promise<void> {
  const ctx = await assertCustomer();
  const supabase = createClient();
  const { error, data } = await supabase
    .from("booking_change_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("requested_by", ctx.userId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new ChangeRequestError(error.message, error.code ?? "update_failed");
  if (!data || data.length === 0) {
    throw new ChangeRequestError(
      "That request can no longer be withdrawn.",
      "not_pending",
    );
  }
}

// ---------------------------------------------------------------------------
// Staff side
// ---------------------------------------------------------------------------

export interface PendingChangeRequestRow extends ChangeRequestRow {
  booking_delivery_date: string;
  booking_pickup_date: string | null;
  booking_address: string;
  booking_status: string;
  customer_name: string;
}

export async function listPendingChangeRequests(): Promise<PendingChangeRequestRow[]> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("booking_change_requests")
    .select(
      `${REQUEST_COLS}, bookings(delivery_date, pickup_date, delivery_address, status, customers(full_name))`,
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listPendingChangeRequests: ${error.message}`);

  return (data ?? []).map((r: Record<string, unknown>) => {
    const booking = r.bookings as
      | {
          delivery_date: string;
          pickup_date: string | null;
          delivery_address: string;
          status: string;
          customers: { full_name?: string } | null;
        }
      | null;
    return {
      id: r.id as string,
      booking_id: r.booking_id as string,
      requested_delivery_date: r.requested_delivery_date as string | null,
      requested_pickup_date: r.requested_pickup_date as string | null,
      reason: r.reason as string,
      status: r.status as ChangeRequestStatus,
      staff_response: r.staff_response as string | null,
      created_at: r.created_at as string,
      resolved_at: r.resolved_at as string | null,
      booking_delivery_date: booking?.delivery_date ?? "",
      booking_pickup_date: booking?.pickup_date ?? null,
      booking_address: booking?.delivery_address ?? "",
      booking_status: booking?.status ?? "",
      customer_name: booking?.customers?.full_name ?? "—",
    };
  });
}

export async function countPendingChangeRequests(): Promise<number> {
  await assertStaff();
  const supabase = createClient();
  const { count, error } = await supabase
    .from("booking_change_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) throw new Error(`countPendingChangeRequests: ${error.message}`);
  return count ?? 0;
}

export async function resolveChangeRequest(
  id: string,
  decision: "approved" | "declined",
  staffResponse?: string,
): Promise<void> {
  const staff = await assertStaff();
  const supabase = createClient();
  const { error, data } = await supabase
    .from("booking_change_requests")
    .update({
      status: decision,
      staff_response: staffResponse?.trim() || null,
      resolved_by: staff.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) throw new ChangeRequestError(error.message, error.code ?? "resolve_failed");
  if (!data || data.length === 0) {
    throw new ChangeRequestError(
      "That request was already resolved.",
      "already_resolved",
    );
  }
}
