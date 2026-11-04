import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertOwner, assertStaff } from "@/lib/auth/requireStaff";
import {
  PAY_LINK_LIMITS,
  type PayLinkSettings,
  type PayLinkSettingsInput,
  type AlertCandidate,
  type AlertRecipientStatus,
} from "./settings-shared";

export * from "./settings-shared";

/**
 * Pay-link settings, read and written on the signed-in person's own session
 * (never service_role). The switch is `cl_pay_link_settings.enabled`; this is
 * the only place the app reads it. The database checks it again when a link
 * is issued (_assert_pay_link_issuable), and the daily cron reads it itself.
 */

const SETTINGS_COLUMNS =
  "enabled, reminder_after_days, reminder_repeat, reminder_max, staff_alert_after_days, " +
  "staff_alert_user_id, staff_alert_each_reminder, updated_at";

export async function getPayLinkSettings(): Promise<PayLinkSettings> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("cl_pay_link_settings")
    .select(SETTINGS_COLUMNS)
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(`cl_pay_link_settings: ${error.message}`);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    // Missing row or unreadable value = off.
    enabled: r.enabled === true,
    reminder_after_days: Number(r.reminder_after_days ?? 2),
    reminder_repeat: r.reminder_repeat === true,
    reminder_max: Number(r.reminder_max ?? 3),
    staff_alert_after_days: Number(r.staff_alert_after_days ?? 3),
    staff_alert_user_id: (r.staff_alert_user_id as string | null) ?? null,
    staff_alert_each_reminder: r.staff_alert_each_reminder === true,
    updated_at: (r.updated_at as string | null) ?? null,
  };
}

/** Live links, and how many of them have no stored copy (can't go in a reminder until Resend). */
export async function getLiveCounts(): Promise<{ live: number; withoutStoredLink: number }> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("pay_link_live_counts");
  if (error) throw new Error(`pay_link_live_counts: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { live?: number; without_stored_link?: number } | null;
  return { live: Number(row?.live ?? 0), withoutStoredLink: Number(row?.without_stored_link ?? 0) };
}

/**
 * Who the unpaid-booking alert would reach — mirrors the rule inside
 * pay_link_staff_alert_recipients() (service_role only, so not called here):
 * the chosen person if they are an active, visible staff/owner, otherwise
 * every visible, active owner. "Removed" stands in for "banned", since Remove
 * is what bans an account.
 */
export async function getAlertRecipientStatus(alertUserId: string | null): Promise<AlertRecipientStatus> {
  await assertStaff();
  const supabase = createClient();
  const [{ data: chosen, error: cErr }, { count, error: oErr }] = await Promise.all([
    alertUserId
      ? supabase
          .from("profiles")
          .select("id, full_name, role, removed_at, hidden_from_users")
          .eq("id", alertUserId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner")
      .is("removed_at", null)
      .eq("hidden_from_users", false),
  ]);
  if (cErr) throw new Error(`profiles: ${cErr.message}`);
  if (oErr) throw new Error(`profiles: ${oErr.message}`);
  const c = chosen as { full_name: string | null; role: string; removed_at: string | null; hidden_from_users: boolean } | null;
  const usable =
    !!c && (c.role === "staff" || c.role === "owner") && !c.removed_at && !c.hidden_from_users;
  return {
    chosenName: c?.full_name ?? null,
    chosenUsable: usable,
    usingFallback: !usable,
    visibleOwners: count ?? 0,
  };
}

/** The alert-user picker: active, visible staff and owners (owner-only RPC). */
export async function listAlertCandidates(): Promise<AlertCandidate[]> {
  await assertOwner();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("list_staff_users");
  if (error) throw new Error(`list_staff_users: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[])
    .filter(
      (r) =>
        (r.role === "staff" || r.role === "owner") &&
        !r.removed_at &&
        // An invite nobody has accepted can't read an alert yet.
        !(r.invited_at && !r.email_confirmed_at),
    )
    .map((r) => ({ id: r.id as string, name: (r.full_name as string | null) ?? (r.email as string | null) ?? "Unnamed", role: r.role as "staff" | "owner" }));
}

export async function savePayLinkSettings(input: PayLinkSettingsInput): Promise<void> {
  const owner = await assertOwner();
  if (input.staff_alert_user_id) {
    const ok = (await listAlertCandidates()).some((c) => c.id === input.staff_alert_user_id);
    if (!ok) throw new Error("Pick an active staff or owner account for unpaid-booking alerts.");
  }
  for (const [k, [lo, hi]] of Object.entries(PAY_LINK_LIMITS)) {
    const v = input[k as keyof typeof PAY_LINK_LIMITS];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${k} must be a whole number from ${lo} to ${hi}.`);
  }
  const supabase = createClient();
  const { data, error } = await supabase
    .from("cl_pay_link_settings")
    .update({
      enabled: input.enabled,
      reminder_after_days: input.reminder_after_days,
      reminder_repeat: input.reminder_repeat,
      reminder_max: input.reminder_max,
      staff_alert_after_days: input.staff_alert_after_days,
      staff_alert_user_id: input.staff_alert_user_id,
      staff_alert_each_reminder: input.staff_alert_each_reminder,
      updated_by: owner.userId,
    })
    .eq("id", true)
    .select("enabled");
  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === "bad_alert_user") throw new Error("Pick an active staff or owner account for unpaid-booking alerts.");
    if (error.code === "23514") throw new Error("One of the numbers is outside what the database allows.");
    if (error.code === "42501") throw new Error("Only the owner can change pay-link settings.");
    throw new Error(error.message);
  }
  // RLS turns a refused UPDATE into zero rows, not an error.
  if (!data || data.length !== 1) throw new Error("Only the owner can change pay-link settings.");
}
