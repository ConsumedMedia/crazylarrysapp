/**
 * Pay-link settings: types, the database's limits, form parsing and the
 * environment warnings. Pure (reads process.env only in envWarnings), so the
 * Settings form and tests can use it.
 */

export interface PayLinkSettings {
  enabled: boolean;
  reminder_after_days: number;
  reminder_repeat: boolean;
  reminder_max: number;
  staff_alert_after_days: number;
  staff_alert_user_id: string | null;
  staff_alert_each_reminder: boolean;
  updated_at: string | null;
}

export type PayLinkSettingsInput = Omit<PayLinkSettings, "updated_at">;

/** The check constraints on cl_pay_link_settings (20261103000000). */
export const PAY_LINK_LIMITS = {
  reminder_after_days: [1, 30],
  reminder_max: [1, 10],
  staff_alert_after_days: [1, 30],
} as const;

export interface AlertCandidate {
  id: string;
  name: string;
  role: "staff" | "owner";
}

export interface AlertRecipientStatus {
  chosenName: string | null;
  /** The chosen person is an active, visible staff member or owner. */
  chosenUsable: boolean;
  /** Alerts go to every visible, active owner instead. */
  usingFallback: boolean;
  visibleOwners: number;
}

type FormLike = { get(name: string): FormDataEntryValue | null };

const LABELS: Record<keyof typeof PAY_LINK_LIMITS, string> = {
  reminder_after_days: "Reminder after (days)",
  reminder_max: "Maximum reminders",
  staff_alert_after_days: "Staff alert after (days)",
};

export function parsePayLinkSettingsForm(
  form: FormLike,
): { ok: true; value: PayLinkSettingsInput } | { ok: false; error: string } {
  const ints: Partial<Record<keyof typeof PAY_LINK_LIMITS, number>> = {};
  for (const key of Object.keys(PAY_LINK_LIMITS) as (keyof typeof PAY_LINK_LIMITS)[]) {
    const raw = String(form.get(key) ?? "").trim();
    const [lo, hi] = PAY_LINK_LIMITS[key];
    if (!/^\d+$/.test(raw)) return { ok: false, error: `${LABELS[key]}: enter a whole number from ${lo} to ${hi}.` };
    const n = Number(raw);
    if (n < lo || n > hi) return { ok: false, error: `${LABELS[key]}: must be from ${lo} to ${hi}.` };
    ints[key] = n;
  }
  const alertUser = String(form.get("staff_alert_user_id") ?? "").trim();
  if (alertUser && !/^[0-9a-f-]{36}$/i.test(alertUser)) return { ok: false, error: "Pick someone from the list." };
  return {
    ok: true,
    value: {
      enabled: form.get("enabled") === "on",
      reminder_after_days: ints.reminder_after_days!,
      reminder_repeat: form.get("reminder_repeat") === "on",
      reminder_max: ints.reminder_max!,
      staff_alert_after_days: ints.staff_alert_after_days!,
      staff_alert_user_id: alertUser || null,
      staff_alert_each_reminder: form.get("staff_alert_each_reminder") === "on",
    },
  };
}

export type EnvWarning = "token_key_missing" | "test_redirect_on" | "notifications_disabled";

/** Server environment problems that change what pay links actually do. Never returns values. */
export function envWarnings(env: NodeJS.ProcessEnv = process.env): EnvWarning[] {
  const out: EnvWarning[] = [];
  if ((env.CL_PAY_LINK_TOKEN_KEY ?? "").trim().length < 32) out.push("token_key_missing");
  if ((env.CL_NOTIFICATIONS_TEST_TO ?? "").trim()) out.push("test_redirect_on");
  if (env.CL_NOTIFICATIONS_ENABLED !== "1") out.push("notifications_disabled");
  return out;
}
