import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { assertOwner } from "@/lib/auth/requireStaff";
import { createDriver, updateDriver } from "@/lib/drivers/manage";

/**
 * Owner Users page: list / edit / remove / restore staff, owners and drivers,
 * plus pending-invite resend + revoke.
 *
 * Enforcement is layered: every function here is assertOwner()-gated and
 * refuses protected accounts up front, and the database enforces the same
 * rules independently (profiles_guard_admin_fields + the owner-checked RPCs in
 * 20261005010000_users_page.sql). Role and profile writes go through the
 * ACTING owner's own session so those triggers see the real person; the
 * service role is used only for auth-admin calls (ban, invite, delete login),
 * which the profiles trigger can't see — hence the explicit refusals here.
 */

export class TeamError extends Error {
  constructor(message: string, readonly openJobs?: OpenJob[]) {
    super(message);
    this.name = "TeamError";
  }
}

export type UserStatus = "active" | "invite_pending" | "removed";

export interface StaffUser {
  id: string;
  fullName: string | null;
  phone: string | null;
  role: "customer" | "driver" | "staff" | "owner";
  email: string | null;
  isProtected: boolean;
  status: UserStatus;
  lastSignInAt: string | null;
  invitedAt: string | null;
  driverId: string | null;
  driverActive: boolean;
  vehicleInfo: string | null;
  truckId: string | null;
  truckNickname: string | null;
}

export interface OpenJob {
  jobId: string;
  bookingId: string;
  type: string;
  scheduledDate: string | null;
  address: string;
}

// A ban long enough to be permanent; Restore lifts it.
const BAN_DURATION = "876000h";

function statusOf(r: {
  removed_at: string | null;
  invited_at: string | null;
  email_confirmed_at: string | null;
}): UserStatus {
  if (r.removed_at) return "removed";
  if (r.invited_at && !r.email_confirmed_at) return "invite_pending";
  return "active";
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "https://app.crazylarrysdumpsters.com";
}

export async function listStaffUsers(): Promise<StaffUser[]> {
  await assertOwner();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_staff_users");
  if (error) throw new TeamError(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    fullName: (r.full_name as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    role: r.role as StaffUser["role"],
    email: (r.email as string | null) ?? null,
    isProtected: r.is_protected === true,
    status: statusOf(r as Parameters<typeof statusOf>[0]),
    lastSignInAt: (r.last_sign_in_at as string | null) ?? null,
    invitedAt: (r.invited_at as string | null) ?? null,
    driverId: (r.driver_id as string | null) ?? null,
    driverActive: r.driver_active === true,
    vehicleInfo: (r.vehicle_info as string | null) ?? null,
    truckId: (r.truck_id as string | null) ?? null,
    truckNickname: (r.truck_nickname as string | null) ?? null,
  }));
}

export async function listOpenJobs(profileId: string): Promise<OpenJob[]> {
  await assertOwner();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("open_jobs_for_profile", { p_profile_id: profileId });
  if (error) throw new TeamError(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((j) => ({
    jobId: j.job_id as string,
    bookingId: j.booking_id as string,
    type: j.job_type as string,
    scheduledDate: (j.scheduled_date as string | null) ?? null,
    address: j.delivery_address as string,
  }));
}

interface Target {
  id: string;
  role: StaffUser["role"];
  full_name: string | null;
  phone: string | null;
  is_protected: boolean;
  removed_at: string | null;
  driver: { id: string; active: boolean; vehicle_info: string | null } | null;
  truckId: string | null;
}

/** Loads the account and refuses protected ones — before any write. */
async function loadTarget(profileId: string): Promise<Target> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, role, full_name, phone, is_protected, removed_at, drivers(id, active, vehicle_info)")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new TeamError(error.message);
  if (!data) throw new TeamError("Account not found.");
  if (data.is_protected) throw new TeamError("This account is protected and can't be changed here.");
  const d = (Array.isArray(data.drivers) ? data.drivers[0] : data.drivers) as Target["driver"] | undefined;
  let truckId: string | null = null;
  if (d) {
    const { data: t } = await supabase.from("trucks").select("id").eq("assigned_driver_id", d.id).maybeSingle();
    truckId = (t?.id as string | undefined) ?? null;
  }
  return {
    id: data.id as string,
    role: data.role as StaffUser["role"],
    full_name: (data.full_name as string | null) ?? null,
    phone: (data.phone as string | null) ?? null,
    is_protected: false,
    removed_at: (data.removed_at as string | null) ?? null,
    driver: d ?? null,
    truckId,
  };
}

async function refuseIfOpenJobs(profileId: string, what: string): Promise<void> {
  const jobs = await listOpenJobs(profileId);
  if (jobs.length) {
    throw new TeamError(`${what}: this driver has ${jobs.length} open job(s). Reassign them first.`, jobs);
  }
}

export interface EditUserInput {
  profileId: string;
  fullName: string;
  phone: string | null;
  /** 'none' = no staff/owner access (driver-only). */
  access: "staff" | "owner" | "none";
  driver: boolean;
  truckId: string | null;
  vehicleInfo: string | null;
}

/**
 * Edit name / phone / role / driver access + truck. Writes only what changed,
 * and the role write is compare-and-set against the role we read, so a
 * concurrent edit can't be silently overwritten.
 */
export async function editUser(input: EditUserInput): Promise<void> {
  await assertOwner();
  const t = await loadTarget(input.profileId);
  if (t.removed_at) throw new TeamError("This account is removed. Restore it first.");

  const fullName = input.fullName.trim();
  if (!fullName) throw new TeamError("Name is required.");
  const phone = input.phone?.trim() || null;
  if (input.access === "none" && !input.driver) {
    throw new TeamError("That would leave no access at all — use Remove instead.");
  }

  // Every refusal happens before the first write, so a refused edit changes
  // nothing (the role write below used to land before this check).
  const turningDriverOff = !!t.driver && t.driver.active && !input.driver;
  if (turningDriverOff) await refuseIfOpenJobs(t.id, "Can't turn off driver access");

  const supabase = createClient();
  const desiredRole: StaffUser["role"] = input.access === "none" ? "driver" : input.access;

  if (desiredRole !== t.role) {
    const { data, error } = await supabase
      .from("profiles")
      .update({ role: desiredRole })
      .eq("id", t.id)
      .eq("role", t.role)
      .select("id");
    if (error) throw new TeamError(`Role change failed: ${error.message}`);
    if (!data?.length) throw new TeamError("Someone else changed this account just now. Reload and try again.");
  }

  if (input.driver && !t.driver) {
    // createDriver also writes name/phone and never touches a staff/owner role.
    await createDriver({
      profile_id: t.id,
      full_name: fullName,
      phone,
      vehicle_info: input.vehicleInfo,
      truck_id: input.truckId,
    });
    return;
  }

  if (t.driver) {
    if (turningDriverOff) {
      await updateDriver(t.driver.id, { full_name: fullName, phone, active: false, truck_id: null });
    } else if (input.driver) {
      await updateDriver(t.driver.id, {
        full_name: fullName,
        phone,
        vehicle_info: input.vehicleInfo,
        active: true,
        ...(input.truckId !== t.truckId ? { truck_id: input.truckId } : {}),
      });
    } else {
      // driver row exists but is already inactive: just keep name/phone in sync
      await updateDriver(t.driver.id, { full_name: fullName, phone });
    }
    return;
  }

  if (fullName !== t.full_name || phone !== t.phone) {
    const { error } = await supabase.from("profiles").update({ full_name: fullName, phone }).eq("id", t.id);
    if (error) throw new TeamError(error.message);
  }
}

/**
 * Remove: clear access + keep the record (remove_staff_user RPC), then ban the
 * login. Self-removal needs the owner to type their own email.
 * Returns whether the caller removed themselves (they must be signed out).
 */
export async function removeUser(profileId: string, confirmEmail: string | null): Promise<{ self: boolean }> {
  const ctx = await assertOwner();
  const self = ctx.userId === profileId;
  if (self && (confirmEmail ?? "").trim().toLowerCase() !== (ctx.email ?? "").toLowerCase()) {
    throw new TeamError("Type your own email address exactly to remove yourself.");
  }
  const t = await loadTarget(profileId);
  if (t.removed_at) throw new TeamError("This account is already removed.");
  if (t.driver) await refuseIfOpenJobs(profileId, "Can't remove");

  const supabase = createClient();
  const { error } = await supabase.rpc("remove_staff_user", { p_profile_id: profileId });
  if (error) throw new TeamError(error.message);

  const service = createServiceClient();
  const { error: banErr } = await service.auth.admin.updateUserById(profileId, { ban_duration: BAN_DURATION });
  if (banErr) {
    // Access is already gone (role cleared); say so plainly rather than pretend.
    throw new TeamError(`Access removed, but blocking the login failed: ${banErr.message}. Try Remove again later.`);
  }
  return { self };
}

/** Restore: lift the ban, clear the removed state, email a set-password link. */
export async function restoreUser(profileId: string): Promise<void> {
  await assertOwner();
  const t = await loadTarget(profileId);
  if (!t.removed_at) throw new TeamError("This account isn't removed.");

  const service = createServiceClient();
  const { data: u, error: getErr } = await service.auth.admin.getUserById(profileId);
  if (getErr || !u.user?.email) throw new TeamError(`Couldn't load the login: ${getErr?.message ?? "no email"}`);
  const { error: unbanErr } = await service.auth.admin.updateUserById(profileId, { ban_duration: "none" });
  if (unbanErr) throw new TeamError(`Couldn't unblock the login: ${unbanErr.message}`);

  const supabase = createClient();
  const { error } = await supabase.rpc("restore_staff_user", { p_profile_id: profileId });
  if (error) throw new TeamError(error.message);

  const { error: mailErr } = await supabase.auth.resetPasswordForEmail(u.user.email, {
    redirectTo: `${siteUrl()}/accept-invite`,
  });
  if (mailErr) throw new TeamError(`Restored, but the set-password email failed: ${mailErr.message}`);
}

async function loadPending(profileId: string): Promise<{ email: string; fullName: string | null }> {
  await loadTarget(profileId); // refuses protected
  const service = createServiceClient();
  const { data, error } = await service.auth.admin.getUserById(profileId);
  if (error || !data.user?.email) throw new TeamError(`Couldn't load the invite: ${error?.message ?? "no email"}`);
  if (!data.user.invited_at || data.user.email_confirmed_at) {
    throw new TeamError("This person has already accepted their invite.");
  }
  return {
    email: data.user.email,
    fullName: (data.user.user_metadata?.full_name as string | undefined) ?? null,
  };
}

/** Re-send the invite email to someone who hasn't accepted yet. */
export async function resendInvite(profileId: string): Promise<void> {
  await assertOwner();
  const p = await loadPending(profileId);
  const service = createServiceClient();
  const { error } = await service.auth.admin.inviteUserByEmail(p.email, {
    data: p.fullName ? { full_name: p.fullName } : undefined,
    redirectTo: `${siteUrl()}/accept-invite`,
  });
  if (error) throw new TeamError(`Resend failed: ${error.message}`);
}

/**
 * Revoke a pending invite: delete the never-used login so the address can be
 * invited again. Refuses anything with history (account_reference_count > 0
 * after dropping an unused driver row) — that's a Remove, not a revoke.
 */
export async function revokeInvite(profileId: string): Promise<void> {
  await assertOwner();
  await loadPending(profileId);
  const supabase = createClient();

  const { data: drv } = await supabase.from("drivers").select("id").eq("profile_id", profileId).maybeSingle();
  if (drv) {
    const { count } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", drv.id as string);
    if ((count ?? 0) > 0) throw new TeamError("This invited driver already has jobs. Use Remove instead.");
    await supabase.from("trucks").update({ assigned_driver_id: null }).eq("assigned_driver_id", drv.id as string);
    const { error } = await supabase.from("drivers").delete().eq("id", drv.id as string);
    if (error) throw new TeamError(error.message);
  }

  const { data: refs, error: refErr } = await supabase.rpc("account_reference_count", { p_profile_id: profileId });
  if (refErr) throw new TeamError(refErr.message);
  if (Number(refs) > 0) throw new TeamError("This account already has history. Use Remove instead.");

  const service = createServiceClient();
  const { error } = await service.auth.admin.deleteUser(profileId);
  if (error) throw new TeamError(`Revoke failed: ${error.message}`);
}
