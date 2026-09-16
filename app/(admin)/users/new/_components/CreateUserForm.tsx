"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { ProfileOption } from "@/lib/users/manage";
import type { TruckOption } from "@/lib/drivers/manage";
import { createUserAction, type CreateUserState } from "../actions";

const init: CreateUserState = { ok: false };
const inputCls = "border-2 border-line bg-bg px-2.5 py-2 text-[13px] text-ink";
const labelCls = "flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3";

function Save({ disabled }: { disabled: boolean }) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || status.pending}
      className="bg-teal px-4 py-2.5 text-left text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {status.pending ? "Creating…" : "Create user"}
    </button>
  );
}

export function CreateUserForm({
  profiles,
  trucks,
}: {
  profiles: ProfileOption[];
  trucks: TruckOption[];
}) {
  const [state, action] = useFormState(createUserAction, init);

  const [mode, setMode] = useState<"invite" | "existing">("invite");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [fullName, setFullName] = useState("");

  const [grantStaff, setGrantStaff] = useState(false);
  const [grantDriver, setGrantDriver] = useState(false);
  const canSubmit = grantStaff || grantDriver;

  function pickExisting(id: string) {
    setSelectedProfileId(id);
    const p = profiles.find((x) => x.id === id);
    if (p?.full_name) setFullName(p.full_name);
  }

  return (
    <form action={action} className="flex flex-col gap-5 border-2 border-line-strong bg-surface p-5">
      {/* --- person --- */}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.12em]">
          Person
        </legend>
        <div className="flex gap-4 text-[13px] font-semibold">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="invite"
              checked={mode === "invite"}
              onChange={() => setMode("invite")}
            />
            Invite a new person
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="existing"
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
            />
            Grant access to an existing account
          </label>
        </div>

        {mode === "invite" ? (
          <label className={labelCls}>
            Email
            <input type="email" name="email" required className={inputCls} />
          </label>
        ) : (
          <label className={labelCls}>
            Account
            <select
              name="profile_id"
              required
              value={selectedProfileId}
              onChange={(e) => pickExisting(e.target.value)}
              className={inputCls}
            >
              <option value="">Select a profile…</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name ?? p.id.slice(0, 8)} ({p.role})
                </option>
              ))}
            </select>
          </label>
        )}

        <label className={labelCls}>
          Full name
          <input
            name="full_name"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={inputCls}
          />
        </label>
      </fieldset>

      {/* --- access grants --- */}
      <fieldset className="flex flex-col gap-4 border-t-2 border-line pt-4">
        <legend className="mb-1 text-[13px] font-extrabold uppercase tracking-[0.12em]">
          Access
        </legend>

        <div className="flex flex-col gap-2 border-2 border-line p-3">
          <label className="flex items-center gap-2 text-[13px] font-bold">
            <input
              type="checkbox"
              name="grant_staff"
              checked={grantStaff}
              onChange={(e) => setGrantStaff(e.target.checked)}
            />
            Staff / owner access
          </label>
          {grantStaff && (
            <div className="ml-6 flex gap-4 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="radio" name="staff_role" value="staff" defaultChecked />
                Staff
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="staff_role" value="owner" />
                Owner
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-2 border-line p-3">
          <label className="flex items-center gap-2 text-[13px] font-bold">
            <input
              type="checkbox"
              name="grant_driver"
              checked={grantDriver}
              onChange={(e) => setGrantDriver(e.target.checked)}
            />
            Driver access
          </label>
          {grantDriver && (
            <div className="ml-6 flex flex-wrap gap-3">
              <label className={labelCls}>
                Phone
                <input name="phone" className={inputCls} />
              </label>
              <label className={labelCls}>
                Vehicle info
                <input name="vehicle_info" className={inputCls} />
              </label>
              <label className={labelCls}>
                Truck
                <select name="truck_id" className={inputCls} defaultValue="">
                  <option value="">— none —</option>
                  {trucks.map((t) => (
                    <option key={t.id} value={t.id} disabled={!!t.assigned_driver_id}>
                      {t.nickname}
                      {t.status !== "active" ? " (inactive)" : ""}
                      {t.assigned_driver_id ? " — assigned" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>

        {!canSubmit && (
          <p className="text-[11px] text-ink-3">Check at least one kind of access.</p>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <Save disabled={!canSubmit} />
        {state.error && (
          <span className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</span>
        )}
        {state.ok && state.message && (
          <span className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</span>
        )}
      </div>
    </form>
  );
}
