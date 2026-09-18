"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface LoginState {
  error?: string;
}

/**
 * One login page (and one accept-invite page), routed by role. Customers
 * book as guests and have no login here (a customer account portal is a
 * later phase). Throws a Next.js redirect on success; returns on failure so
 * the caller can sign the session back out and show an error.
 */
async function redirectByRole(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  const role = (profile?.role as string | undefined) ?? "";

  if (role === "staff" || role === "owner") {
    redirect("/dashboard");
  }
  if (role === "driver") {
    redirect("/driver");
  }
}

export async function signInAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
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

  await redirectByRole(supabase, data.user.id);

  await supabase.auth.signOut();
  return {
    error: "This account isn't set up for the operations or driver app.",
  };
}

export interface CompleteInviteState {
  error?: string;
}

/**
 * Takes the access_token/refresh_token AcceptInviteForm parsed out of the
 * invite/recovery link's URL hash, plus the new password. Does the whole
 * setSession -> updateUser -> role redirect handshake in one server-side
 * call so it all lands in a single response's Set-Cookie headers — doing
 * setSession/updateUser client-side and then calling a server action
 * separately loses the race against @supabase/ssr's async cookie-write
 * listener, so the server action sees no session yet.
 */
export async function completeInviteAction(
  accessToken: string,
  refreshToken: string,
  password: string,
): Promise<CompleteInviteState> {
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = createClient();
  const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (sessionError || !sessionData.user) {
    return { error: "This link is invalid or has expired. Ask an admin to send you a new invite." };
  }

  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    return { error: updateError.message };
  }

  await redirectByRole(supabase, sessionData.user.id);

  await supabase.auth.signOut();
  return {
    error: "This account isn't set up for the operations or driver app.",
  };
}

export async function signOutAction(): Promise<void> {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
