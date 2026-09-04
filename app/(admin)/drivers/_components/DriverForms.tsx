"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { DriverRow } from "@/lib/dispatch/types";
import type { TruckOption, CandidateProfile } from "@/lib/drivers/manage";
import { BRAND_HEX } from "@/lib/design/tokens";
import {
  createDriverAction,
  updateDriverAction,
  toggleDriverActiveAction,
  type DriverActionState,
} from "../actions";

const init: DriverActionState = { ok: false };
const inputCls = "border-2 border-line bg-bg px-2.5 py-2 text-[13px] text-ink";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase();
}

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

function Msg({ s }: { s: DriverActionState }) {
  if (s.error)
    return <span className="text-[12px] font-semibold text-orange-tint-ink">{s.error}</span>;
  if (s.ok && s.message)
    return <span className="text-[12px] font-semibold text-teal-tint-ink">{s.message}</span>;
  return null;
}

function truckOptions(trucks: TruckOption[], selfDriverId?: string) {
  return trucks.map((t) => {
    const takenByOther =
      t.assigned_driver_id && t.assigned_driver_id !== selfDriverId;
    return (
      <option key={t.id} value={t.id} disabled={!!takenByOther}>
        {t.nickname}
        {t.status !== "active" ? " (inactive)" : ""}
        {takenByOther ? " — assigned" : ""}
      </option>
    );
  });
}

export function AddDriver({
  candidates,
  trucks,
}: {
  candidates: CandidateProfile[];
  trucks: TruckOption[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useFormState(createDriverAction, init);

  if (state.ok && open) setTimeout(() => setOpen(false), 300);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-teal px-3.5 py-2.5 text-left text-[12px] font-extrabold text-white hover:bg-teal-700"
      >
        + Add a driver
      </button>
    );
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-3 border-2 border-line-strong bg-surface p-4"
    >
      <div className="text-[13px] font-extrabold uppercase tracking-[0.12em]">
        New driver
      </div>
      {candidates.length === 0 ? (
        <p className="text-[12px] text-ink-2">
          No unlinked profiles. Invite the driver in Supabase Auth first, then
          they&apos;ll appear here.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Account
            <select name="profile_id" required className={inputCls}>
              <option value="">Select a profile…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name ?? c.id.slice(0, 8)} ({c.role})
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
              Full name
              <input name="full_name" required className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
              Phone
              <input name="phone" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
              Truck
              <select name="truck_id" className={inputCls} defaultValue="">
                <option value="">— none —</option>
                {truckOptions(trucks)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Vehicle info
            <input name="vehicle_info" className={inputCls} />
          </label>
          <div className="flex items-center gap-3">
            <Save label="Add driver" />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="border-2 border-line px-3 py-2 text-[12px] font-extrabold text-ink-2 hover:border-ink"
            >
              Cancel
            </button>
            <Msg s={state} />
          </div>
        </>
      )}
    </form>
  );
}

export function DriverRowEditor({
  driver,
  trucks,
}: {
  driver: DriverRow;
  trucks: TruckOption[];
}) {
  const [editing, setEditing] = useState(false);
  const [state, action] = useFormState(updateDriverAction, init);
  const [toggleState, toggleAction] = useFormState(toggleDriverActiveAction, init);

  if (state.ok && editing) setTimeout(() => setEditing(false), 300);

  const color = driver.active ? BRAND_HEX.teal : BRAND_HEX["gray-st"];

  if (!editing) {
    return (
      <div
        className="flex flex-col gap-3 border-2 border-line-strong bg-surface p-4"
        style={{ borderTop: `5px solid ${color}` }}
      >
        <div className="flex items-start gap-2.5">
          <div
            className="grid h-10 w-10 flex-none place-items-center text-[13px] font-extrabold text-white"
            style={{ background: color }}
          >
            {initials(driver.full_name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-extrabold leading-tight">
              {driver.full_name}
            </div>
            <div className="cl-nums text-[12px] text-ink-2">
              {driver.phone ?? "—"}
            </div>
          </div>
          <form action={toggleAction} className="flex-none">
            <input type="hidden" name="driver_id" value={driver.id} />
            <input type="hidden" name="active" value={(!driver.active).toString()} />
            <button
              className={`whitespace-nowrap px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
                driver.active
                  ? "bg-teal-tint text-teal-tint-ink"
                  : "bg-tint text-ink-2"
              }`}
            >
              {driver.active ? "Active" : "Inactive"}
            </button>
          </form>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-ink-3">
              Truck
            </div>
            <div className="text-[13px] font-bold">
              {driver.truck_nickname ?? <span className="text-ink-3">—</span>}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.13em] text-ink-3">
              Vehicle
            </div>
            <div className="text-[13px] font-bold text-ink-2">
              {driver.vehicle_info ?? "—"}
            </div>
          </div>
        </div>

        {toggleState.error && (
          <div className="text-[11px] text-orange-tint-ink">{toggleState.error}</div>
        )}

        <button
          onClick={() => setEditing(true)}
          className="self-start border-2 border-line px-2.5 py-1.5 text-[11px] font-extrabold hover:border-ink"
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 border-2 border-line-strong bg-tint p-4"
      style={{ borderTop: `5px solid ${color}` }}
    >
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="driver_id" value={driver.id} />
        <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Name
          <input name="full_name" defaultValue={driver.full_name} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Phone
          <input name="phone" defaultValue={driver.phone ?? ""} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Truck
          <select
            name="truck_id"
            defaultValue={driver.truck_id ?? ""}
            className={inputCls}
          >
            <option value="">— none —</option>
            {truckOptions(trucks, driver.id)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Vehicle info
          <input
            name="vehicle_info"
            defaultValue={driver.vehicle_info ?? ""}
            className={inputCls}
          />
        </label>
        <Save />
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="border-2 border-line px-3 py-2 text-[12px] font-extrabold text-ink-2 hover:border-ink"
        >
          Cancel
        </button>
        <Msg s={state} />
      </form>
    </div>
  );
}
