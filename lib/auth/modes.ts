import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Whether to offer the admin ↔ driver mode switch links. Display only — the
 * real gates are still requireStaff()/requireDriver() on each side, so a link
 * appearing (or not) never grants or removes access by itself.
 *
 * Reads run on the user's own session: a staff member can read their own
 * drivers row ("drivers: staff full access"), and anyone can read their own
 * profile ("profiles: user reads own").
 */

/** Admin side: show "Driver view" only with an ACTIVE driver row. */
export async function hasActiveDriverRow(userId: string): Promise<boolean> {
  const supabase = createClient();
  const { data } = await supabase
    .from("drivers")
    .select("id")
    .eq("profile_id", userId)
    .eq("active", true)
    .maybeSingle();
  return !!data;
}

/** Driver side: show "Admin view" only for staff/owner accounts. */
export async function hasStaffRole(userId: string): Promise<boolean> {
  const supabase = createClient();
  const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  const role = data?.role as string | undefined;
  return role === "staff" || role === "owner";
}
