"use server";

import { revalidatePath } from "next/cache";
import { createUserWithAccess, CreateUserError } from "@/lib/users/manage";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface CreateUserState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): CreateUserState {
  if (e instanceof CreateUserError || e instanceof NotAuthorizedError) {
    return { ok: false, error: e.message };
  }
  console.error("[create user]", e);
  return { ok: false, error: "Something went wrong." };
}

export async function createUserAction(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  try {
    const mode = (String(formData.get("mode") ?? "invite") === "existing"
      ? "existing"
      : "invite") as "invite" | "existing";
    const grantStaff = formData.get("grant_staff") === "on";
    const grantDriver = formData.get("grant_driver") === "on";
    const staffRoleRaw = String(formData.get("staff_role") ?? "");

    const result = await createUserWithAccess({
      mode,
      email: String(formData.get("email") ?? "").trim() || undefined,
      profileId: String(formData.get("profile_id") ?? "") || undefined,
      fullName: String(formData.get("full_name") ?? ""),
      grantStaff,
      staffRole: staffRoleRaw === "staff" || staffRoleRaw === "owner" ? staffRoleRaw : undefined,
      grantDriver,
      phone: String(formData.get("phone") ?? "").trim() || null,
      vehicleInfo: String(formData.get("vehicle_info") ?? "").trim() || null,
      truckId: String(formData.get("truck_id") ?? "") || null,
    });

    revalidatePath("/users/new");
    revalidatePath("/drivers");

    const parts: string[] = [];
    if (result.invited) parts.push("invite sent");
    if (result.grantedStaff) parts.push("staff/owner access granted");
    if (result.grantedDriver) parts.push("driver access granted");

    return { ok: true, message: `${parts.join(" · ")}.` };
  } catch (e) {
    return toState(e);
  }
}
