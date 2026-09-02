"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { PricingConfig } from "@/lib/bookings/pricing";
import {
  saveSizePricingAction,
  saveGlobalSettingsAction,
  type SettingsState,
} from "../actions";

const init: SettingsState = { ok: false };
const input = "border-2 border-line bg-bg px-2.5 py-2 text-[14px] text-ink";

function Save({ label = "Save" }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-teal px-3.5 py-2 text-left text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "…" : label}
    </button>
  );
}

function Feedback({ state }: { state: SettingsState }) {
  if (state.error)
    return (
      <span className="text-[12px] font-semibold text-orange-tint-ink">
        {state.error}
      </span>
    );
  if (state.ok && state.message)
    return (
      <span className="text-[12px] font-semibold text-teal-tint-ink">
        {state.message}
      </span>
    );
  return null;
}

export function SizePricingRow({
  size,
  base_price,
  is_active,
  canEdit,
}: PricingConfig["sizes"][number] & { canEdit: boolean }) {
  const [state, action] = useFormState(saveSizePricingAction, init);
  return (
    <form
      action={action}
      className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3 last:border-b-0"
    >
      <input type="hidden" name="size" value={size} />
      <div className="w-16 text-[14px] font-extrabold">
        {size.replace("yd", " yd")}
      </div>
      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Base price
        <input
          name="base_price"
          defaultValue={base_price > 0 ? base_price.toFixed(2) : ""}
          placeholder="0.00"
          disabled={!canEdit}
          className={`${input} w-28 cl-nums`}
        />
      </label>
      <label className="flex items-center gap-2 text-[12px] font-bold">
        <input
          type="checkbox"
          name="is_active"
          defaultChecked={is_active}
          disabled={!canEdit}
        />
        Active (bookable)
      </label>
      {canEdit && <Save />}
      <Feedback state={state} />
    </form>
  );
}

export function GlobalSettingsForm({
  config,
  canEdit,
}: {
  config: PricingConfig;
  canEdit: boolean;
}) {
  const [state, action] = useFormState(saveGlobalSettingsAction, init);
  const s = config.settings;
  return (
    <form action={action} className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Extra day rate ($/day)
          <input
            name="extra_day_rate"
            defaultValue={s.extra_day_rate > 0 ? s.extra_day_rate.toFixed(2) : ""}
            placeholder="0.00"
            disabled={!canEdit}
            className={`${input} w-28 cl-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Overage rate ($/ton)
          <input
            name="overage_ton_rate"
            defaultValue={
              s.overage_ton_rate > 0 ? s.overage_ton_rate.toFixed(2) : ""
            }
            placeholder="0.00"
            disabled={!canEdit}
            className={`${input} w-28 cl-nums`}
          />
        </label>
      </div>

      <div className="border-2 border-orange bg-orange-tint p-3">
        <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-orange-tint-ink">
          Sales tax — verify against the delivery jurisdiction
        </div>
        <p className="mb-3 text-[12px] text-orange-tint-ink">
          Ohio sales tax varies by county / municipality. Enter the rate that
          applies to Larry&apos;s delivery area and confirm it against the Ohio
          Department of Taxation rate table — not just the owner&apos;s word.
        </p>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-orange-tint-ink">
            Tax rate (%)
            <input
              name="tax_rate_pct"
              defaultValue={s.tax_rate > 0 ? (s.tax_rate * 100).toFixed(3) : ""}
              placeholder="7.500"
              disabled={!canEdit}
              className={`${input} w-28 cl-nums`}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-orange-tint-ink">
            Jurisdiction
            <input
              name="tax_jurisdiction"
              defaultValue={s.tax_jurisdiction ?? ""}
              placeholder="Franklin County, OH"
              disabled={!canEdit}
              className={`${input} w-56`}
            />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-[12px] font-bold text-orange-tint-ink">
          <input
            type="checkbox"
            name="tax_verified"
            defaultChecked={s.tax_verified}
            disabled={!canEdit}
          />
          Verified against the official rate table
        </label>
        <input
          name="tax_verified_note"
          defaultValue={s.tax_verified_note ?? ""}
          placeholder="How / when verified"
          disabled={!canEdit}
          className={`${input} mt-2 w-full`}
        />
        {!s.tax_verified && s.tax_rate > 0 && (
          <p className="mt-2 text-[12px] font-extrabold text-orange-tint-ink">
            ⚠ Bookings are using an unverified tax rate.
          </p>
        )}
      </div>

      {canEdit && (
        <div className="flex items-center gap-3">
          <Save label="Save global rates" />
          <Feedback state={state} />
        </div>
      )}
    </form>
  );
}
