"use client";

import { useFormState, useFormStatus } from "react-dom";
import { formatCutoffTime } from "@/lib/bookings/cutoff-shared";
import {
  CUTOFF_TIME_OPTIONS,
  type BookingCutoffSettings,
} from "@/lib/bookings/cutoff-settings-shared";
import { saveBookingCutoffAction, type SettingsState } from "../actions";

const init: SettingsState = { ok: false };
const label = "flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3";
const input = "border-2 border-line bg-bg px-2.5 py-2 text-[14px] text-ink";

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="self-start bg-teal px-3.5 py-2 text-left text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "…" : "Save order cutoff"}
    </button>
  );
}

/**
 * Settings → Order cutoff. Owners turn it on/off and pick the time; staff see
 * it read-only. `settings` null = it couldn't be read (bookings then follow
 * today's rule: tomorrow).
 */
export function BookingCutoffPanel({
  settings,
  canEdit,
}: {
  settings: BookingCutoffSettings | null;
  canEdit: boolean;
}) {
  const [state, action] = useFormState(saveBookingCutoffAction, init);
  const on = settings?.cutoff_enabled === true;
  const time = settings ? formatCutoffTime(settings.cutoff_time) : null;

  return (
    <section className="border-2 border-line-strong bg-surface" data-testid="booking-cutoff-panel">
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-line-strong px-4 py-3">
        <span className="text-[15px] font-extrabold">Order cutoff</span>
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${
            on ? "bg-teal-tint text-teal-tint-ink" : "bg-tint text-ink-2"
          }`}
        >
          {on ? "On" : "Off"}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] text-ink-2">
          While it&apos;s on, online and pay-link orders placed at or after the cutoff time (Eastern) can&apos;t
          choose tomorrow: the earliest delivery is the day after tomorrow. Phone bookings made here by staff
          can always choose tomorrow.
        </p>

        {!settings ? (
          <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
            The order cutoff couldn&apos;t be read just now. Until it can, bookings follow the usual rule: tomorrow or
            later.
          </p>
        ) : canEdit ? (
          <form action={action} className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-[13px] font-semibold">
              <input type="checkbox" name="cutoff_enabled" defaultChecked={on} />
              Turn the order cutoff on
            </label>
            <label className={label}>
              Cutoff time (Eastern)
              <select name="cutoff_time" defaultValue={settings.cutoff_time} className={input}>
                {CUTOFF_TIME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {state.error && <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>}
            {state.ok && state.message && <p className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</p>}
            <Save />
          </form>
        ) : (
          <p className="text-[13px] font-semibold">
            {on ? `On — online and pay-link orders after ${time} Eastern deliver from the day after tomorrow.` : `Off (time set to ${time}).`}{" "}
            <span className="font-normal text-ink-3">Read-only — only an owner can change it.</span>
          </p>
        )}
      </div>
    </section>
  );
}
