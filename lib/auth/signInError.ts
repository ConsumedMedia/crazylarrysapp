import type { AuthError } from "@supabase/supabase-js";

/**
 * Turn a signInWithPassword failure into the message the user sees.
 *
 * Only a real credentials rejection (HTTP 400, code invalid_credentials) says
 * "Invalid email or password." Anything else — Supabase unreachable, a TLS
 * failure, a 5xx, rate limiting — was previously reported the same way, which
 * on 2026-09-24 sent a local-dev network failure (antivirus TLS interception)
 * down the "wrong password" path. Those are logged with the real cause and
 * shown as a service problem instead.
 */
export function signInErrorMessage(error: AuthError | null, where: string): string {
  if (!error) return "Invalid email or password.";
  if (error.code === "invalid_credentials" || error.status === 400) {
    return "Invalid email or password.";
  }
  console.error(
    `[${where}] sign-in failed for a non-credential reason:`,
    error.name,
    error.status,
    error.code,
    error.message,
  );
  if (error.status === 429) {
    return "Too many sign-in attempts. Wait a minute and try again.";
  }
  return "Couldn't reach the sign-in service. Try again in a moment.";
}
