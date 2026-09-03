import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import { notifyJobAssigned, notifyJobComplete } from "@/lib/notifications/notify";

export class DispatchError extends Error {
  code: string;
  detail: string | null;
  hint: string | null;
  constructor(message: string, opts: { code?: string; detail?: string | null; hint?: string | null } = {}) {
    super(message);
    this.name = "DispatchError";
    this.code = opts.code ?? "error";
    this.detail = opts.detail ?? null;
    this.hint = opts.hint ?? null;
  }
}

function wrap(e: { message: string; code?: string | null; details?: string | null; hint?: string | null }): never {
  throw new DispatchError(e.message, {
    code: e.code ?? "rpc_failed",
    detail: e.details ?? null,
    hint: e.hint ?? null,
  });
}

export async function assignJob(input: {
  jobId: string;
  driverId: string;
  dumpsterId?: string | null;
  override?: boolean;
}): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("assign_job", {
    p_job_id: input.jobId,
    p_driver_id: input.driverId,
    p_dumpster_id: input.dumpsterId ?? null,
    p_override: input.override ?? false,
  });
  if (error) wrap(error);
  await notifyJobAssigned(input.jobId, input.driverId);
}

export async function unassignJob(jobId: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("unassign_job", { p_job_id: jobId });
  if (error) wrap(error);
}

export async function assignUnit(bookingId: string, dumpsterId: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("assign_unit", {
    p_booking_id: bookingId,
    p_dumpster_id: dumpsterId,
  });
  if (error) wrap(error);
}

export async function clearUnit(bookingId: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("clear_unit", { p_booking_id: bookingId });
  if (error) wrap(error);
}

export async function setRouteOrder(
  driverId: string,
  date: string,
  orderedJobIds: string[],
): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("set_route_order", {
    p_driver_id: driverId,
    p_date: date,
    p_job_ids: orderedJobIds,
  });
  if (error) wrap(error);
}

export async function confirmJobTags(bookingId: string, tags: string[]): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("confirm_job_tags", {
    p_booking_id: bookingId,
    p_tags: tags,
  });
  if (error) wrap(error);
}

/** complete_job — usable by staff here; drivers use lib/driver/mutations. */
export async function completeJobAsStaff(jobId: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("complete_job", { p_job_id: jobId });
  if (error) wrap(error);
  const job = data as { id: string; type: "delivery" | "pickup"; booking_id: string } | null;
  if (job?.booking_id) {
    await notifyJobComplete({ id: job.id, type: job.type, booking_id: job.booking_id });
  }
}
