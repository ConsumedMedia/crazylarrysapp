import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface DriverContext {
  userId: string;
  driverId: string;
  fullName: string;
  active: boolean;
}

/**
 * Gate for the driver dashboard.
 *  - no session          -> /login
 *  - session but no linked drivers row -> /login?denied=1
 * Staff/owner without a drivers row are NOT drivers — they view driver days
 * through the admin surfaces, not here.
 */
export async function requireDriver(): Promise<DriverContext> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, full_name, active")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (!driver) redirect("/login?denied=1");

  return {
    userId: user.id,
    driverId: (driver as { id: string }).id,
    fullName: (driver as { full_name: string }).full_name,
    active: (driver as { active: boolean }).active,
  };
}
