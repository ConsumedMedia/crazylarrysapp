import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";
import { fleetSummary } from "@/lib/dumpsters/queries";
import type { FleetSummary } from "@/lib/dumpsters/types";
import { getNotificationHealth, type ChannelHealth } from "@/lib/notifications/health";
import { todayYmd } from "@/lib/availability/dates";

export interface MovementRow {
  jobId: string;
  bookingId: string;
  type: "delivery" | "pickup";
  status: string;
  address: string;
  size: string;
  customerName: string;
  driverName: string | null;
}

export interface OverdueRow {
  bookingId: string;
  address: string;
  pickupDate: string | null;
  customerName: string;
}

export interface UnassignedRow {
  jobId: string;
  bookingId: string;
  type: "delivery" | "pickup";
  scheduledDate: string;
  address: string;
  customerName: string;
}

export interface OverviewData {
  today: string;
  movementsToday: MovementRow[];
  counts: {
    deliveriesToday: number;
    pickupsToday: number;
    activeRentals: number;
    overdue: number;
    unassigned: number;
  };
  fleet: FleetSummary;
  overdueBookings: OverdueRow[];
  unassignedJobs: UnassignedRow[];
  notificationHealth: ChannelHealth[];
}

/**
 * Everything the Overview page needs, staff-visible (no $ figures — those are
 * a separate owner-only read). One page, a handful of parallel queries.
 */
export async function getOverview(): Promise<OverviewData> {
  await requireStaff();
  const supabase = createClient();
  const today = todayYmd();

  const [
    { data: todaysJobs },
    { count: activeRentals },
    { count: overdue },
    { data: overdueBookings },
    { data: unassignedJobs },
    fleet,
    notificationHealth,
  ] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, booking_id, type, status, bookings!inner(delivery_address, size_requested, customers!inner(full_name)), drivers(full_name)",
      )
      .eq("scheduled_date", today)
      .neq("status", "cancelled")
      .order("type", { ascending: true }),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "overdue"),
    supabase
      .from("bookings")
      .select("id, delivery_address, pickup_date, customers!inner(full_name)")
      .eq("status", "overdue")
      .order("pickup_date", { ascending: true })
      .limit(10),
    supabase
      .from("jobs")
      .select(
        "id, booking_id, type, scheduled_date, bookings!inner(delivery_address, customers!inner(full_name))",
      )
      .eq("status", "unassigned")
      .order("scheduled_date", { ascending: true })
      .limit(10),
    fleetSummary(),
    getNotificationHealth(),
  ]);

  const movementsToday: MovementRow[] = (todaysJobs ?? []).map((r: Record<string, unknown>) => {
    const b = r.bookings as Record<string, unknown>;
    const c = b.customers as { full_name?: string };
    const d = r.drivers as { full_name?: string } | null;
    return {
      jobId: r.id as string,
      bookingId: r.booking_id as string,
      type: r.type as "delivery" | "pickup",
      status: r.status as string,
      address: b.delivery_address as string,
      size: b.size_requested as string,
      customerName: c?.full_name ?? "—",
      driverName: d?.full_name ?? null,
    };
  });

  // total unassigned (not just the 10 shown) — a separate lightweight count.
  const { count: unassignedCount } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "unassigned");

  return {
    today,
    movementsToday,
    counts: {
      deliveriesToday: movementsToday.filter((m) => m.type === "delivery").length,
      pickupsToday: movementsToday.filter((m) => m.type === "pickup").length,
      activeRentals: activeRentals ?? 0,
      overdue: overdue ?? 0,
      unassigned: unassignedCount ?? 0,
    },
    fleet,
    overdueBookings: (overdueBookings ?? []).map((r: Record<string, unknown>) => ({
      bookingId: r.id as string,
      address: r.delivery_address as string,
      pickupDate: (r.pickup_date as string | null) ?? null,
      customerName: (r.customers as { full_name?: string })?.full_name ?? "—",
    })),
    unassignedJobs: (unassignedJobs ?? []).map((r: Record<string, unknown>) => {
      const b = r.bookings as Record<string, unknown>;
      return {
        jobId: r.id as string,
        bookingId: r.booking_id as string,
        type: r.type as "delivery" | "pickup",
        scheduledDate: r.scheduled_date as string,
        address: b.delivery_address as string,
        customerName: (b.customers as { full_name?: string })?.full_name ?? "—",
      };
    }),
    notificationHealth,
  };
}

/** Owner-only: revenue actually collected today (paid invoices, paid_at = today). */
export async function getRevenueToday(): Promise<number> {
  const supabase = createClient();
  const today = todayYmd();
  const { data } = await supabase
    .from("invoices")
    .select("amount, paid_at")
    .eq("status", "paid")
    .gte("paid_at", `${today}T00:00:00Z`)
    .lt("paid_at", `${today}T23:59:59.999Z`);
  return (data ?? []).reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
}
