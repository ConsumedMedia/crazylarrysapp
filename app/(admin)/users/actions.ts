"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";
import { createClient } from "@/lib/supabase/server";
import {
  TeamError,
  editUser,
  removeUser,
  restoreUser,
  resendInvite,
  revokeInvite,
  type OpenJob,
} from "@/lib/users/team";

export interface TeamActionState {
  ok: boolean;
  error?: string;
  message?: string;
  openJobs?: OpenJob[];
}

function toState(e: unknown): TeamActionState {
  if (e instanceof TeamError) return { ok: false, error: e.message, openJobs: e.openJobs };
  if (e instanceof NotAuthorizedError) return { ok: false, error: e.message };
  // DriverManageError / CreateUserError carry user-safe messages too.
  if (e instanceof Error && /ManageError|CreateUserError/.test(e.name)) return { ok: false, error: e.message };
  console.error("[users]", e);
  return { ok: false, error: "Something went wrong." };
}

const id = (fd: FormData) => String(fd.get("id") ?? "");

export async function editUserAction(_prev: TeamActionState, fd: FormData): Promise<TeamActionState> {
  try {
    const access = String(fd.get("access") ?? "");
    await editUser({
      profileId: id(fd),
      fullName: String(fd.get("full_name") ?? ""),
      phone: String(fd.get("phone") ?? "").trim() || null,
      access: access === "owner" || access === "staff" ? access : "none",
      driver: fd.get("driver") === "on",
      truckId: String(fd.get("truck_id") ?? "") || null,
      vehicleInfo: String(fd.get("vehicle_info") ?? "").trim() || null,
    });
    revalidatePath("/users");
    revalidatePath("/drivers");
    return { ok: true, message: "Saved." };
  } catch (e) {
    return toState(e);
  }
}

export async function removeUserAction(_prev: TeamActionState, fd: FormData): Promise<TeamActionState> {
  let self = false;
  try {
    ({ self } = await removeUser(id(fd), String(fd.get("confirm_email") ?? "") || null));
  } catch (e) {
    return toState(e);
  }
  if (self) {
    await createClient().auth.signOut();
    redirect("/login");
  }
  revalidatePath("/users");
  revalidatePath("/drivers");
  return { ok: true, message: "Removed. Their login is blocked and the record is kept." };
}

export async function restoreUserAction(_prev: TeamActionState, fd: FormData): Promise<TeamActionState> {
  try {
    await restoreUser(id(fd));
    revalidatePath("/users");
    return { ok: true, message: "Restored and emailed a set-password link. Grant access with Edit." };
  } catch (e) {
    return toState(e);
  }
}

export async function resendInviteAction(_prev: TeamActionState, fd: FormData): Promise<TeamActionState> {
  try {
    await resendInvite(id(fd));
    revalidatePath("/users");
    return { ok: true, message: "Invite re-sent." };
  } catch (e) {
    return toState(e);
  }
}

export async function revokeInviteAction(_prev: TeamActionState, fd: FormData): Promise<TeamActionState> {
  try {
    await revokeInvite(id(fd));
    revalidatePath("/users");
    return { ok: true, message: "Invite revoked. The address can be invited again." };
  } catch (e) {
    return toState(e);
  }
}
