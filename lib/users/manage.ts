import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { assertOwner } from "@/lib/auth/requireStaff";
import { createDriver } from "@/lib/drivers/manage";

export class CreateUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateUserError";
  }
}

export interface ProfileOption {
  id: string;
  full_name: string | null;
  role: string;
}

/**
 * Every profile, not just unlinked ones (unlike drivers/manage.ts's
 * listCandidateProfiles) — the whole point of this screen is that an
 * existing staff/owner/driver/customer account can gain additional access,
 * not just brand-new signups. Owner-only: this feeds the privilege-grant
 * screen, so the candidate list itself is gated the same as the grant.
 */
export async function listAllProfiles(): Promise<ProfileOption[]> {
  await assertOwner();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .order("full_name", { ascending: true, nullsFirst: false });
  if (error) throw new CreateUserError(error.message);
  return (data ?? []) as ProfileOption[];
}

export interface CreateUserInput {
  mode: "invite" | "existing";
  email?: string;
  profileId?: string;
  fullName: string;
  grantStaff: boolean;
  staffRole?: "staff" | "owner";
  grantDriver: boolean;
  phone?: string | null;
  vehicleInfo?: string | null;
  truckId?: string | null;
}

export interface CreateUserResult {
  profileId: string;
  invited: boolean;
  grantedStaff: boolean;
  grantedDriver: boolean;
}

/**
 * The unified "create user" flow — owner-only. Either invites a brand-new
 * person by email (supabase.auth.admin.inviteUserByEmail — they set their
 * own password via the email link) or targets an existing profile, then
 * applies up to two independent access grants:
 *
 *   - staff/owner role — written via the ACTING owner's own session client
 *     (not service role), so enforce_profile_role_change's is_owner()/
 *     is_staff() checks apply exactly as they do everywhere else in the app.
 *   - driver access — delegates to drivers/manage.ts's createDriver(), which
 *     (as of the role-clobbering fix) never overwrites an existing staff/
 *     owner role, so granting both at once is safe in either order.
 *
 * At least one grant is required — an account with neither is just a
 * customer signup, which is a different (unauthenticated) flow.
 */
export async function createUserWithAccess(
  input: CreateUserInput,
): Promise<CreateUserResult> {
  await assertOwner();

  if (!input.grantStaff && !input.grantDriver) {
    throw new CreateUserError("Grant at least one kind of access.");
  }
  if (input.grantStaff && input.staffRole !== "staff" && input.staffRole !== "owner") {
    throw new CreateUserError("Pick staff or owner.");
  }
  if (!input.fullName.trim()) {
    throw new CreateUserError("Full name is required.");
  }
  if (input.mode === "invite" && !input.email?.trim()) {
    throw new CreateUserError("Email is required to invite a new person.");
  }
  if (input.mode === "existing" && !input.profileId) {
    throw new CreateUserError("Pick an existing profile.");
  }

  let profileId: string;
  let invited = false;

  if (input.mode === "invite") {
    const service = createServiceClient();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://app.crazylarrysdumpsters.com";
    const { data, error } = await service.auth.admin.inviteUserByEmail(
      input.email!.trim(),
      { data: { full_name: input.fullName.trim() }, redirectTo: `${siteUrl}/accept-invite` },
    );
    if (error) throw new CreateUserError(`Invite failed: ${error.message}`);
    if (!data.user) throw new CreateUserError("Invite failed: no user returned.");
    profileId = data.user.id;
    invited = true;
  } else {
    profileId = input.profileId!;
  }

  if (input.grantStaff) {
    const supabase = createClient();
    const { error } = await supabase
      .from("profiles")
      .update({ role: input.staffRole, full_name: input.fullName.trim() })
      .eq("id", profileId);
    if (error) throw new CreateUserError(`Role grant failed: ${error.message}`);
  }

  if (input.grantDriver) {
    await createDriver({
      profile_id: profileId,
      full_name: input.fullName.trim(),
      phone: input.phone ?? null,
      vehicle_info: input.vehicleInfo ?? null,
      truck_id: input.truckId ?? null,
    });
  }

  return {
    profileId,
    invited,
    grantedStaff: input.grantStaff,
    grantedDriver: input.grantDriver,
  };
}
