import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface CustomerContext {
  userId: string;
  email: string | null;
  fullName: string | null;
}

export class NotAuthorizedError extends Error {
  constructor(message = "Account access required") {
    super(message);
    this.name = "NotAuthorizedError";
  }
}

/**
 * Server-side gate for the customer account portal.
 *
 * Authorization is role-based (profiles.role === 'customer'), not keyed on a
 * `customers` row existing — a brand-new signup has no `customers` row until
 * their first booking, and that's a valid, empty account state, not an auth
 * failure. Pages render an empty booking history for that case.
 *
 *  - No session              -> redirect to /account/login
 *  - Session but not customer -> redirect to /account/login?denied=1
 */
export async function requireCustomer(): Promise<CustomerContext> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/account/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const role = profile?.role as string | undefined;
  if (role !== "customer") {
    redirect("/account/login?denied=1");
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    fullName: (profile?.full_name as string | null) ?? null,
  };
}

/** Non-redirecting variant for server actions/mutations. */
export async function assertCustomer(): Promise<CustomerContext> {
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
  if (role !== "customer") {
    throw new NotAuthorizedError();
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    fullName: (profile?.full_name as string | null) ?? null,
  };
}
