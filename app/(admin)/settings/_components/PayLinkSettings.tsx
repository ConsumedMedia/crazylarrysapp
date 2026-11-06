"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  PAY_LINK_LIMITS,
  type AlertCandidate,
  type AlertRecipientStatus,
  type EnvWarning,
  type PayLinkSettings,
} from "@/lib/pay-links/settings-shared";
import { savePayLinkSettingsAction, type SettingsState } from "../actions";

const init: SettingsState = { ok: false };
const input = "border-2 border-line bg-bg px-2.5 py-2 text-[14px] text-ink";
const label = "flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3";

const ENV_TEXT: Record<EnvWarning, string> = {
  token_key_missing:
    "CL_PAY_LINK_TOKEN_KEY isn't set on this server, so reminders can't include the link. New links work; reminders for them can't send until the key is set and staff press Resend.",
  test_redirect_on:
    "CL_NOTIFICATIONS_TEST_TO is set: pay-link messages go to the test address, not the customer.",
  notifications_disabled:
    "CL_NOTIFICATIONS_ENABLED isn't 1: no pay-link texts or emails are actually sent.",
};

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
      {children}
    </p>
  );
}

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="self-start bg-teal px-3.5 py-2 text-left text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "…" : "Save pay-link settings"}
    </button>
  );
}

export function PayLinkSettingsPanel({
  settings,
  canEdit,
  candidates,
  recipient,
  live,
  warnings,
}: {
  settings: PayLinkSettings;
  canEdit: boolean;
  /** Owners only; staff see the chosen name read-only. */
  candidates: AlertCandidate[];
  recipient: AlertRecipientStatus;
  live: { live: number; withoutStoredLink: number };
  warnings: EnvWarning[];
}) {
  const [state, action] = useFormState(savePayLinkSettingsAction, init);
  const s = settings;
  // Chosen and still valid, but not someone this owner can see: keep the choice
  // without naming them, or the dropdown would fall to "All visible owners" and
  // the next save would silently clear it.
  const keepCurrent =
    s.staff_alert_user_id && recipient.chosenUsable && !candidates.some((c) => c.id === s.staff_alert_user_id)
      ? s.staff_alert_user_id
      : null;

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-line-strong px-4 py-3">
        <span className="text-[15px] font-extrabold">Customer pay links</span>
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${
            s.enabled ? "bg-teal-tint text-teal-tint-ink" : "bg-tint text-ink-2"
          }`}
        >
          {s.enabled ? "On" : "Off"}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] font-semibold">
          {live.live === 1 ? "1 link is live" : `${live.live} links are live`}
          {live.withoutStoredLink > 0 &&
            ` · ${live.withoutStoredLink} can't go in a reminder until staff press Resend`}
          {!s.enabled && live.live > 0 && " · they stay payable while pay links are off"}
        </p>

        {warnings.map((w) => (
          <Warn key={w}>{ENV_TEXT[w]}</Warn>
        ))}
        {recipient.usingFallback && (
          <Warn>
            {s.staff_alert_user_id
              ? `${recipient.chosenName ?? "The chosen person"} is removed, hidden or no longer staff`
              : "No alert person is chosen"}
            {" — unpaid-booking alerts go to all visible owners."}
          </Warn>
        )}

        <form action={action} className="flex flex-col gap-3">
          <label className="flex items-start gap-2.5 text-[13px] font-bold">
            <input type="checkbox" name="enabled" defaultChecked={s.enabled} disabled={!canEdit} className="mt-0.5 h-4 w-4" />
            <span>
              Pay links on — staff bookings send the customer a link to pay by card.
              <span className="block text-[11px] font-normal text-ink-3">
                Turning this off stops new links and reminders. Links already sent stay payable.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap gap-3">
            <label className={label}>
              Reminder after (days)
              <input
                name="reminder_after_days"
                type="number"
                min={PAY_LINK_LIMITS.reminder_after_days[0]}
                max={PAY_LINK_LIMITS.reminder_after_days[1]}
                step={1}
                defaultValue={s.reminder_after_days}
                disabled={!canEdit}
                className={`${input} w-24 cl-nums`}
              />
            </label>
            <label className={label}>
              Maximum reminders
              <input
                name="reminder_max"
                type="number"
                min={PAY_LINK_LIMITS.reminder_max[0]}
                max={PAY_LINK_LIMITS.reminder_max[1]}
                step={1}
                defaultValue={s.reminder_max}
                disabled={!canEdit}
                className={`${input} w-24 cl-nums`}
              />
            </label>
            <label className={label}>
              Staff alert after (days)
              <input
                name="staff_alert_after_days"
                type="number"
                min={PAY_LINK_LIMITS.staff_alert_after_days[0]}
                max={PAY_LINK_LIMITS.staff_alert_after_days[1]}
                step={1}
                defaultValue={s.staff_alert_after_days}
                disabled={!canEdit}
                className={`${input} w-24 cl-nums`}
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-[12px] font-bold">
            <input type="checkbox" name="reminder_repeat" defaultChecked={s.reminder_repeat} disabled={!canEdit} />
            Repeat the reminder every {s.reminder_after_days} day{s.reminder_after_days === 1 ? "" : "s"} (up to the maximum)
          </label>

          <label className={label}>
            Unpaid-booking alerts go to
            {canEdit ? (
              <select name="staff_alert_user_id" defaultValue={s.staff_alert_user_id ?? ""} className={`${input} max-w-sm`}>
                <option value="">All visible owners</option>
                {keepCurrent && <option value={keepCurrent}>Current recipient</option>}
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.role})
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[14px] font-bold normal-case tracking-normal text-ink">
                {recipient.usingFallback ? "All visible owners" : (recipient.chosenName ?? "Current recipient")}
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 text-[12px] font-bold">
            <input
              type="checkbox"
              name="staff_alert_each_reminder"
              defaultChecked={s.staff_alert_each_reminder}
              disabled={!canEdit}
            />
            Also alert staff on each customer reminder
          </label>

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Save />
              {state.error && <span className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</span>}
              {state.ok && state.message && (
                <span className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</span>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-ink-2">Read-only — only the owner can change pay-link settings.</p>
          )}
        </form>
      </div>
    </section>
  );
}
