import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { DumpsterStatus } from "@/lib/dumpsters/state-machine";

export type StaffRole = "staff" | "owner";

export interface StaffContext {
  userId: string;
  email: string | null;
  role: StaffRole;
  fullName: string | null;
}

export class NotAuthorizedError extends Error {
  constructor(message = "Staff access required") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

/**
 * Server-side gate for every admin surface and every dumpster mutation.
 *
 * - No session            -> redirect to /login
 * - Session but not staff  -> redirect to /login?denied=1
 *
 * Role is read from public.profiles (RLS lets a user read their own row).
 * The database RPCs re-check is_staff() independently, so this is the first
 * of two lines of defense, not the only one.
 */
export async function requireStaff(): Promise<StaffContext> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const role = profile?.role as string | undefined;
  if (role !== "staff" && role !== "owner") {
    redirect("/login?denied=1");
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    role: role as StaffRole,
    fullName: (profile?.full_name as string | null) ?? null,
  };
}

/**
 * Non-redirecting variant for server actions: throws instead of redirecting so
 * the caller can surface a form error.
 */
export async function assertStaff(): Promise<StaffContext> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new NotAuthorizedError("You are signed out");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const role = profile?.role as string | undefined;
  if (role !== "staff" && role !== "owner") {
    throw new NotAuthorizedError();
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    role: role as StaffRole,
    fullName: (profile?.full_name as string | null) ?? null,
  };
}

/**
 * Owner-only gate. Business-level actions (connecting QuickBooks, etc.) that a
 * regular staff member should not be able to trigger. Redirecting variant.
 */
export async function requireOwner(): Promise<StaffContext> {
  const ctx = await requireStaff();
  if (ctx.role !== "owner") {
    redirect("/login?denied=1");
  }
  return ctx;
}

/** Non-redirecting owner gate for route handlers / server actions. */
export async function assertOwner(): Promise<StaffContext> {
  const ctx = await assertStaff();
  if (ctx.role !== "owner") {
    throw new NotAuthorizedError("Owner access required");
  }
  return ctx;
}

// Re-export for convenience in callers that also need the status union.
export type { DumpsterStatus };
