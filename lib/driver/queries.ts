import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireDriver } from "@/lib/auth/requireDriver";
import { requireStaff } from "@/lib/auth/requireStaff";
import type { DispatchJob } from "@/lib/dispatch/types";

const JOB_SELECT = `
  id, type, status, scheduled_date, route_order, completed_at, driver_id, booking_id,
  bookings!inner (
    size_requested, delivery_address, debris_type, placement_notes, job_tags,
    job_tags_confirmed_at, status, dumpster_id,
    dumpsters ( unit_number ),
    customers!inner ( full_name, phone, company_name )
  )
`;

function mapJob(r: Record<string, unknown>): DispatchJob {
  const b = r.bookings as Record<string, unknown>;
  const c = b.customers as Record<string, unknown>;
  const d = b.dumpsters as { unit_number?: string } | null;
  return {
    id: r.id as string,
    type: r.type as DispatchJob["type"],
    status: r.status as DispatchJob["status"],
    scheduled_date: r.scheduled_date as string,
    route_order: (r.route_order as number | null) ?? null,
    completed_at: (r.completed_at as string | null) ?? null,
    driver_id: (r.driver_id as string | null) ?? null,
    booking_id: r.booking_id as string,
    size_requested: b.size_requested as DispatchJob["size_requested"],
    delivery_address: b.delivery_address as string,
    debris_type: (b.debris_type as string | null) ?? null,
    placement_notes: (b.placement_notes as string | null) ?? null,
    job_tags: (b.job_tags as string[] | null) ?? [],
    job_tags_confirmed_at: (b.job_tags_confirmed_at as string | null) ?? null,
    booking_status: b.status as string,
    dumpster_id: (b.dumpster_id as string | null) ?? null,
    dumpster_unit: d?.unit_number ?? null,
    customer_name: c.full_name as string,
    customer_phone: (c.phone as string | null) ?? null,
    customer_company: (c.company_name as string | null) ?? null,
  };
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The signed-in driver's own jobs. RLS ("jobs: driver reads assigned jobs")
 *  already restricts to their assigned jobs; the date filter is applied on top. */
export async function myJobs(date?: string): Promise<{
  date: string;
  driverName: string;
  active: boolean;
  jobs: DispatchJob[];
}> {
  const ctx = await requireDriver();
  const d = date ?? todayYmd();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("scheduled_date", d)
    .neq("status", "cancelled")
    .order("route_order", { ascending: true, nullsFirst: false })
    .order("type", { ascending: true });
  if (error) throw new Error(`myJobs: ${error.message}`);
  return {
    date: d,
    driverName: ctx.fullName,
    active: ctx.active,
    jobs: (data ?? []).map((r) => mapJob(r as Record<string, unknown>)),
  };
}

export async function myJob(jobId: string): Promise<DispatchJob | null> {
  await requireDriver();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`myJob: ${error.message}`);
  return data ? mapJob(data as Record<string, unknown>) : null;
}

/** Staff oversight: any driver's day (read-only view). */
export async function staffViewDriverDay(
  driverId: string,
  date: string,
): Promise<DispatchJob[]> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("driver_id", driverId)
    .eq("scheduled_date", date)
    .neq("status", "cancelled")
    .order("route_order", { ascending: true, nullsFirst: false })
    .order("type", { ascending: true });
  if (error) throw new Error(`staffViewDriverDay: ${error.message}`);
  return (data ?? []).map((r) => mapJob(r as Record<string, unknown>));
}
