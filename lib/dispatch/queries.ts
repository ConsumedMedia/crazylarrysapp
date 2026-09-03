import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";
import type { DispatchJob, DriverRow, AssignmentCheck } from "./types";

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

export async function listUnassignedJobs(): Promise<DispatchJob[]> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_SELECT)
    .eq("status", "unassigned")
    .order("scheduled_date", { ascending: true });
  if (error) throw new Error(`listUnassignedJobs: ${error.message}`);
  return (data ?? []).map((r) => mapJob(r as Record<string, unknown>));
}

export async function listDriverJobs(
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
  if (error) throw new Error(`listDriverJobs: ${error.message}`);
  return (data ?? []).map((r) => mapJob(r as Record<string, unknown>));
}

export async function listDrivers(): Promise<DriverRow[]> {
  await requireStaff();
  const supabase = createClient();
  const [{ data: drivers, error }, { data: trucks }] = await Promise.all([
    supabase
      .from("drivers")
      .select("id, profile_id, full_name, phone, vehicle_info, active")
      .order("full_name", { ascending: true }),
    supabase.from("trucks").select("id, nickname, status, assigned_driver_id"),
  ]);
  if (error) throw new Error(`listDrivers: ${error.message}`);

  const byDriver = new Map<string, { id: string; nickname: string; status: string }>();
  for (const t of trucks ?? []) {
    if (t.assigned_driver_id) {
      byDriver.set(t.assigned_driver_id as string, {
        id: t.id as string,
        nickname: t.nickname as string,
        status: t.status as string,
      });
    }
  }

  return (drivers ?? []).map((r: Record<string, unknown>) => {
    const t = byDriver.get(r.id as string);
    return {
      id: r.id as string,
      profile_id: r.profile_id as string,
      full_name: r.full_name as string,
      phone: (r.phone as string | null) ?? null,
      vehicle_info: (r.vehicle_info as string | null) ?? null,
      active: r.active as boolean,
      truck_id: t?.id ?? null,
      truck_nickname: t?.nickname ?? null,
      truck_status: t?.status ?? null,
    };
  });
}

/** available units of a given size, for the dispatch unit picker */
export async function listAvailableUnits(
  size: string,
): Promise<Array<{ id: string; unit_number: string }>> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("dumpsters")
    .select("id, unit_number")
    .eq("size", size)
    .eq("status", "available")
    .order("unit_number", { ascending: true });
  if (error) throw new Error(`listAvailableUnits: ${error.message}`);
  return (data ?? []) as Array<{ id: string; unit_number: string }>;
}

export type CheckMatrix = Record<string, Record<string, AssignmentCheck>>;

/** check_job_assignment for every (unassigned job × active driver) pair. */
export async function checkMatrix(
  jobIds: string[],
  driverIds: string[],
): Promise<CheckMatrix> {
  await requireStaff();
  const supabase = createClient();
  const pairs = jobIds.flatMap((j) => driverIds.map((d) => ({ j, d })));
  const results = await Promise.all(
    pairs.map(async ({ j, d }) => {
      const { data, error } = await supabase
        .rpc("check_job_assignment", { p_job_id: j, p_driver_id: d })
        .single();
      if (error) return { j, d, check: null as AssignmentCheck | null };
      const x = data as Record<string, unknown>;
      return {
        j,
        d,
        check: {
          allowed: x.allowed as boolean,
          requires_override: x.requires_override as boolean,
          truck_id: (x.truck_id as string | null) ?? null,
          truck_nickname: (x.truck_nickname as string | null) ?? null,
          blockers: (x.blockers as AssignmentCheck["blockers"]) ?? [],
          warnings: (x.warnings as AssignmentCheck["warnings"]) ?? [],
        } as AssignmentCheck,
      };
    }),
  );
  const m: CheckMatrix = {};
  for (const { j, d, check } of results) {
    if (!check) continue;
    (m[j] ??= {})[d] = check;
  }
  return m;
}

export async function checkAssignment(
  jobId: string,
  driverId: string,
): Promise<AssignmentCheck> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .rpc("check_job_assignment", { p_job_id: jobId, p_driver_id: driverId })
    .single();
  if (error) throw new Error(`checkAssignment: ${error.message}`);
  const d = data as Record<string, unknown>;
  return {
    allowed: d.allowed as boolean,
    requires_override: d.requires_override as boolean,
    truck_id: (d.truck_id as string | null) ?? null,
    truck_nickname: (d.truck_nickname as string | null) ?? null,
    blockers: (d.blockers as AssignmentCheck["blockers"]) ?? [],
    warnings: (d.warnings as AssignmentCheck["warnings"]) ?? [],
  };
}
