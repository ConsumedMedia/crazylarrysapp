import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireCustomer } from "@/lib/auth/requireCustomer";
import type { BookingStatus, DocusignStatus } from "@/lib/bookings/state-machine";
import type { DumpsterSize } from "@/lib/dumpsters/state-machine";

const BOOKING_COLS =
  "id, size_requested, delivery_address, delivery_date, pickup_date, status, placement_notes, debris_type, subtotal, tax, total, payment_status, docusign_status, created_at";

export interface CustomerBookingRow {
  id: string;
  size_requested: DumpsterSize;
  delivery_address: string;
  delivery_date: string;
  pickup_date: string | null;
  status: BookingStatus;
  placement_notes: string | null;
  debris_type: string | null;
  subtotal: number;
  tax: number;
  total: number;
  payment_status: "unpaid" | "paid" | "failed" | "refunded";
  docusign_status: DocusignStatus;
  created_at: string;
}

/**
 * RLS ("bookings: customer reads own") already scopes this to the caller's
 * own bookings via customers.profile_id = auth.uid() — no manual filter
 * needed here.
 */
export async function listMyBookings(): Promise<CustomerBookingRow[]> {
  await requireCustomer();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_COLS)
    .order("delivery_date", { ascending: false });
  if (error) throw new Error(`listMyBookings: ${error.message}`);
  return (data ?? []) as CustomerBookingRow[];
}

export async function getMyBookingDetail(
  id: string,
): Promise<CustomerBookingRow | null> {
  await requireCustomer();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getMyBookingDetail: ${error.message}`);
  return (data as CustomerBookingRow | null) ?? null;
}
