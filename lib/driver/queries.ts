import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireDriver } from "@/lib/auth/requireDriver";
import { requireStaff } from "@/lib/auth/requireStaff";
import type { DispatchJob } from "@/lib/dispatch/types";

const JOB_SELECT = `
  id, type, status, scheduled_date, route_order, completed_at, driver_id, booking_id,
  job_photos ( id ),
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
  const photos = r.job_photos as unknown[] | null;
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
    has_photo: Array.isArray(photos) && photos.length > 0,
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

export interface DriverHeaderInfo {
  driverName: string;
  active: boolean;
  truckNickname: string | null;
  date: string;
  jobsDone: number;
  jobsToGo: number;
}

/**
 * Header summary for the driver chrome — always "today," regardless of
 * which date a page happens to be viewing. truckNickname comes through the
 * "trucks: driver reads own assigned truck" RLS policy (Phase 10).
 */
export async function myTodaySummary(): Promise<DriverHeaderInfo> {
  const ctx = await requireDriver();
  const supabase = createClient();
  const date = todayYmd();

  const [{ data: jobs, error: jobsErr }, { data: truck }] = await Promise.all([
    supabase
      .from("jobs")
      .select("status")
      .eq("scheduled_date", date)
      .neq("status", "cancelled"),
    supabase
      .from("trucks")
      .select("nickname")
      .eq("assigned_driver_id", ctx.driverId)
      .maybeSingle(),
  ]);
  if (jobsErr) throw new Error(`myTodaySummary: ${jobsErr.message}`);

  const rows = (jobs ?? []) as { status: string }[];
  const jobsDone = rows.filter((j) => j.status === "completed").length;

  return {
    driverName: ctx.fullName,
    active: ctx.active,
    truckNickname: (truck as { nickname?: string } | null)?.nickname ?? null,
    date,
    jobsDone,
    jobsToGo: rows.length - jobsDone,
  };
}

export interface DriverProfile {
  fullName: string;
  phone: string | null;
  vehicleInfo: string | null;
  active: boolean;
  truckNickname: string | null;
}

/** For the "Me" tab. */
export async function myDriverProfile(): Promise<DriverProfile> {
  const ctx = await requireDriver();
  const supabase = createClient();
  const [{ data: driver, error }, { data: truck }] = await Promise.all([
    supabase
      .from("drivers")
      .select("phone, vehicle_info")
      .eq("id", ctx.driverId)
      .maybeSingle(),
    supabase
      .from("trucks")
      .select("nickname")
      .eq("assigned_driver_id", ctx.driverId)
      .maybeSingle(),
  ]);
  if (error) throw new Error(`myDriverProfile: ${error.message}`);
  return {
    fullName: ctx.fullName,
    phone: (driver as { phone?: string | null } | null)?.phone ?? null,
    vehicleInfo: (driver as { vehicle_info?: string | null } | null)?.vehicle_info ?? null,
    active: ctx.active,
    truckNickname: (truck as { nickname?: string } | null)?.nickname ?? null,
  };
}

/** For the "Done" tab — completed jobs over the last `days` days. */
export async function myRecentCompleted(days = 7): Promise<DispatchJob[]> {
  await requireDriver();
  const supabase = createClient();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceYmd = since.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("status", "completed")
    .gte("scheduled_date", sinceYmd)
    .order("scheduled_date", { ascending: false })
    .order("completed_at", { ascending: false });
  if (error) throw new Error(`myRecentCompleted: ${error.message}`);
  return (data ?? []).map((r) => mapJob(r as Record<string, unknown>));
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
