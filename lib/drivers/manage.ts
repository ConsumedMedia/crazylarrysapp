import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";

export class DriverManageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverManageError";
  }
}

export interface TruckOption {
  id: string;
  nickname: string;
  status: string;
  assigned_driver_id: string | null;
}

export interface CandidateProfile {
  id: string;
  full_name: string | null;
  role: string;
  email: string | null;
}

export async function listTrucks(): Promise<TruckOption[]> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("trucks")
    .select("id, nickname, status, assigned_driver_id")
    .order("nickname");
  if (error) throw new DriverManageError(error.message);
  return (data ?? []) as TruckOption[];
}

/** Profiles not yet linked to a drivers row — candidates for "Add driver". */
export async function listCandidateProfiles(): Promise<CandidateProfile[]> {
  await assertStaff();
  const supabase = createClient();
  const { data: drivers } = await supabase.from("drivers").select("profile_id");
  const taken = new Set((drivers ?? []).map((d) => d.profile_id as string));
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .order("full_name");
  if (error) throw new DriverManageError(error.message);
  return (data ?? [])
    .filter((p) => !taken.has(p.id as string))
    .map((p) => ({
      id: p.id as string,
      full_name: (p.full_name as string | null) ?? null,
      role: p.role as string,
      email: null,
    }));
}

async function setTruckForDriver(
  supabase: ReturnType<typeof createClient>,
  driverId: string,
  truckId: string | null,
): Promise<void> {
  // clear this driver off any truck first (unique constraint on assigned_driver_id)
  await supabase
    .from("trucks")
    .update({ assigned_driver_id: null })
    .eq("assigned_driver_id", driverId);
  if (truckId) {
    const { error } = await supabase
      .from("trucks")
      .update({ assigned_driver_id: driverId })
      .eq("id", truckId);
    if (error) throw new DriverManageError(error.message);
  }
}

export async function createDriver(input: {
  profile_id: string;
  full_name: string;
  phone?: string | null;
  vehicle_info?: string | null;
  truck_id?: string | null;
}): Promise<string> {
  await assertStaff();
  const supabase = createClient();

  const fullName = input.full_name.trim();
  const phone = input.phone?.trim() || null;

  // profiles is the source of truth for name/phone; drivers.* is a synced
  // mirror for query convenience. Promote role to 'driver' if needed (the
  // enforce_profile_role_change trigger requires a staff session — assertStaff
  // guarantees one). full_name/phone updates don't trip that trigger.
  const { data: prof } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", input.profile_id)
    .maybeSingle();
  if (!prof) throw new DriverManageError("Profile not found.");

  const profilePatch: Record<string, unknown> = { full_name: fullName, phone };
  if ((prof.role as string) !== "driver") profilePatch.role = "driver";
  const { error: profErr } = await supabase
    .from("profiles")
    .update(profilePatch)
    .eq("id", input.profile_id);
  if (profErr) throw new DriverManageError(`Update profile: ${profErr.message}`);

  const { data, error } = await supabase
    .from("drivers")
    .insert({
      profile_id: input.profile_id,
      full_name: fullName,
      phone,
      vehicle_info: input.vehicle_info?.trim() || null,
      active: true,
    })
    .select("id")
    .single();
  if (error) throw new DriverManageError(error.message);
  const driverId = (data as { id: string }).id;

  if (input.truck_id !== undefined) {
    await setTruckForDriver(supabase, driverId, input.truck_id ?? null);
  }
  return driverId;
}

export async function updateDriver(
  driverId: string,
  patch: {
    full_name?: string;
    phone?: string | null;
    vehicle_info?: string | null;
    active?: boolean;
    truck_id?: string | null;
  },
): Promise<void> {
  await assertStaff();
  const supabase = createClient();

  const fields: Record<string, unknown> = {};
  const profilePatch: Record<string, unknown> = {};
  if (patch.full_name !== undefined) {
    fields.full_name = patch.full_name.trim();
    profilePatch.full_name = patch.full_name.trim();
  }
  if (patch.phone !== undefined) {
    fields.phone = patch.phone?.trim() || null;
    profilePatch.phone = patch.phone?.trim() || null;
  }
  if (patch.vehicle_info !== undefined)
    fields.vehicle_info = patch.vehicle_info?.trim() || null;
  if (patch.active !== undefined) fields.active = patch.active;

  if (Object.keys(fields).length) {
    const { error } = await supabase
      .from("drivers")
      .update(fields)
      .eq("id", driverId);
    if (error) throw new DriverManageError(error.message);
  }

  // Sync name/phone back to the source-of-truth profile.
  if (Object.keys(profilePatch).length) {
    const { data: d } = await supabase
      .from("drivers")
      .select("profile_id")
      .eq("id", driverId)
      .maybeSingle();
    if (d?.profile_id) {
      const { error } = await supabase
        .from("profiles")
        .update(profilePatch)
        .eq("id", d.profile_id as string);
      if (error) throw new DriverManageError(`Sync profile: ${error.message}`);
    }
  }

  if (patch.truck_id !== undefined) {
    await setTruckForDriver(supabase, driverId, patch.truck_id ?? null);
  }
}
