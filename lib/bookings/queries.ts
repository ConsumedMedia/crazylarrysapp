import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireStaff } from "@/lib/auth/requireStaff";
import type { BookingRow, BookingDetail, CustomerRow, JobRow } from "./types";

const BOOKING_COLS =
  "id, customer_id, dumpster_id, size_requested, delivery_address, delivery_date, pickup_date, status, placement_notes, debris_type, subtotal, tax, total, quickbooks_invoice_id, docusign_status, created_at, updated_at";

export interface BookingListRow extends BookingRow {
  customer_name: string;
}

/** Staff booking list, newest delivery first. */
export async function listBookings(filter?: {
  status?: string;
}): Promise<BookingListRow[]> {
  await requireStaff();
  const supabase = createClient();
  let q = supabase
    .from("bookings")
    .select(`${BOOKING_COLS}, customers(full_name)`)
    .order("delivery_date", { ascending: false });
  if (filter?.status) q = q.eq("status", filter.status);

  const { data, error } = await q;
  if (error) throw new Error(`listBookings: ${error.message}`);

  return (data ?? []).map((r: Record<string, unknown>) => {
    const { customers, ...rest } = r;
    return {
      ...(rest as unknown as BookingRow),
      customer_name:
        (customers as { full_name?: string } | null)?.full_name ?? "—",
    };
  });
}

export async function getBookingDetail(
  id: string,
): Promise<BookingDetail | null> {
  await requireStaff();
  const supabase = createClient();

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(BOOKING_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getBookingDetail: ${error.message}`);
  if (!booking) return null;
  const b = booking as BookingRow;

  const [{ data: customer }, { data: jobs }, { data: history }] =
    await Promise.all([
      supabase
        .from("customers")
        .select("id, profile_id, full_name, email, phone, company_name")
        .eq("id", b.customer_id)
        .maybeSingle(),
      supabase
        .from("jobs")
        .select(
          "id, booking_id, type, driver_id, scheduled_date, status, route_order, completed_at",
        )
        .eq("booking_id", id)
        .order("scheduled_date", { ascending: true }),
      supabase
        .from("status_log")
        .select("id, entity_type, old_status, new_status, changed_at")
        .eq("entity_type", "booking")
        .eq("entity_id", id)
        .order("changed_at", { ascending: false }),
    ]);

  return {
    booking: b,
    customer: (customer ?? {
      id: b.customer_id,
      profile_id: null,
      full_name: "—",
      email: null,
      phone: null,
      company_name: null,
    }) as CustomerRow,
    jobs: (jobs ?? []) as JobRow[],
    history: (history ?? []) as BookingDetail["history"],
  };
}

/**
 * Public confirmation view — service role, no auth. Returns only the
 * non-sensitive fields a customer needs on the "you're booked" screen.
 */
export async function getBookingConfirmation(id: string): Promise<{
  size: string;
  delivery_date: string;
  pickup_date: string | null;
  delivery_address: string;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
} | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "size_requested, delivery_date, pickup_date, delivery_address, subtotal, tax, total, status",
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const d = data as Record<string, unknown>;
  return {
    size: d.size_requested as string,
    delivery_date: d.delivery_date as string,
    pickup_date: (d.pickup_date as string | null) ?? null,
    delivery_address: d.delivery_address as string,
    subtotal: Number(d.subtotal),
    tax: Number(d.tax),
    total: Number(d.total),
    status: d.status as string,
  };
}
