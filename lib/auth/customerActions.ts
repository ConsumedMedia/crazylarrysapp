"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface CustomerAuthState {
  error?: string;
  message?: string;
}

/**
 * Best-effort link of any pre-existing guest `customers` row (matched on
 * verified email) to this now-authenticated profile. Safe to call after
 * every sign-in/sign-up — a no-op once nothing matches. Never blocks the
 * auth flow: failures are logged, not surfaced to the customer.
 */
async function claimGuestBookings(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const { error } = await supabase.rpc("claim_guest_bookings");
  if (error) {
    console.error("[claimGuestBookings]", error.message);
  }
}

export async function signUpCustomerAction(
  _prev: CustomerAuthState,
  formData: FormData,
): Promise<CustomerAuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();

  if (!email || !password || !fullName) {
    return { error: "Name, email, and password are all required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } },
  });

  if (error) {
    return { error: error.message };
  }
  if (!data.session) {
    // Email confirmation is required before a session is issued.
    return {
      message: "Check your email to confirm your account, then sign in.",
    };
  }

  await claimGuestBookings(supabase);
  redirect("/account");
}

export async function signInCustomerAction(
  _prev: CustomerAuthState,
  formData: FormData,
): Promise<CustomerAuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    return { error: "Invalid email or password." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if ((profile?.role as string | undefined) !== "customer") {
    await supabase.auth.signOut();
    return {
      error: "This account isn't set up for customer login.",
    };
  }

  await claimGuestBookings(supabase);
  redirect("/account");
}

export async function signOutCustomerAction(): Promise<void> {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/account/login");
}
