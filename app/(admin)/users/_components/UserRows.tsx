"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { StaffUser } from "@/lib/users/team";
import type { TruckOption } from "@/lib/drivers/manage";
import {
  editUserAction,
  removeUserAction,
  restoreUserAction,
  resendInviteAction,
  revokeInviteAction,
  type TeamActionState,
} from "../actions";

const init: TeamActionState = { ok: false };
const inputCls = "border-2 border-line bg-bg px-2.5 py-2 text-[13px] text-ink";
const labelCls = "flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3";
const btn = "border-2 border-line-strong px-3 py-1.5 text-[12px] font-extrabold hover:bg-bg disabled:opacity-60";
const dangerBtn = "border-2 border-pink px-3 py-1.5 text-[12px] font-extrabold text-pink hover:bg-pink hover:text-white disabled:opacity-60";

const STATUS_LABEL: Record<StaffUser["status"], string> = {
  active: "Active",
  invite_pending: "Invite pending",
  removed: "Removed",
};

function fmt(ts: string | null): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function roleLabel(u: StaffUser): string {
  if (u.status === "removed") return "—";
  if (u.role === "owner") return "Owner";
  if (u.role === "staff") return "Staff";
  if (u.role === "driver") return "Driver only";
  // e.g. restored after a removal: listed, but nothing granted back yet
  return "No access";
}

function driverLabel(u: StaffUser): string {
  if (!u.driverId || !u.driverActive) return "No";
  return u.truckNickname ? `Yes · ${u.truckNickname}` : "Yes · no truck";
}

function Submit({ label, pending, cls }: { label: string; pending: string; cls: string }) {
  const s = useFormStatus();
  return (
    <button type="submit" disabled={s.pending} className={cls}>
      {s.pending ? pending : label}
    </button>
  );
}

function Result({ state }: { state: TeamActionState }) {
  if (state.error) {
    return (
      <div className="flex flex-col gap-1 text-[12px] font-semibold text-pink">
        <span>{state.error}</span>
        {state.openJobs && state.openJobs.length > 0 && (
          <ul className="list-disc pl-5 font-normal text-ink-2">
            {state.openJobs.map((j) => (
              <li key={j.jobId}>
                <a className="underline" href={`/bookings/${j.bookingId}`}>
                  {j.type} {j.scheduledDate ?? "unscheduled"} — {j.address}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (state.ok && state.message) return <span className="text-[12px] font-semibold text-teal">{state.message}</span>;
  return null;
}

/** Your own account: shown to every owner, no controls anywhere. */
export function ProtectedCard({ user }: { user: StaffUser }) {
  return (
    <div className="grid gap-1 border-2 border-line-strong bg-surface p-3 text-[13px] md:grid-cols-[1.4fr_1.6fr_0.7fr_1fr]">
      <span className="font-extrabold">{user.fullName ?? user.email}</span>
      <span className="text-ink-2">{user.email}</span>
      <span>{roleLabel(user)}</span>
      <span className="text-ink-2">Last sign-in: {fmt(user.lastSignInAt)}</span>
      <span className="text-[11px] text-ink-3 md:col-span-4">
        Protected account — it can&apos;t be edited, demoted or removed from the app.
      </span>
    </div>
  );
}

export function UserRow({
  user,
  trucks,
  isSelf,
  selfEmail,
}: {
  user: StaffUser;
  trucks: TruckOption[];
  isSelf: boolean;
  selfEmail: string | null;
}) {
  const [open, setOpen] = useState<"edit" | "remove" | null>(null);

  return (
    <div className="border-2 border-line bg-surface">
      <div className="grid gap-2 p-3 text-[13px] md:grid-cols-[1.4fr_1.6fr_0.7fr_1.1fr_0.8fr_1fr_auto] md:items-center md:gap-3">
        <span className="font-extrabold">
          {user.fullName ?? "—"}
          {isSelf && <span className="ml-1 text-[11px] font-semibold text-ink-3">(you)</span>}
        </span>
        <span className="break-all text-ink-2">{user.email}</span>
        <span>{roleLabel(user)}</span>
        <span>{driverLabel(user)}</span>
        <span className={user.status === "active" ? "" : "font-semibold text-pink"}>{STATUS_LABEL[user.status]}</span>
        <span className="text-ink-2">{fmt(user.lastSignInAt)}</span>
        <div className="flex flex-wrap gap-2">
          {user.status === "active" && (
            <>
              <button className={btn} onClick={() => setOpen(open === "edit" ? null : "edit")}>
                Edit
              </button>
              <button className={dangerBtn} onClick={() => setOpen(open === "remove" ? null : "remove")}>
                Remove
              </button>
            </>
          )}
          {user.status === "invite_pending" && <InviteControls id={user.id} />}
          {user.status === "removed" && <RestoreControl id={user.id} />}
        </div>
      </div>
      {open === "edit" && <EditForm user={user} trucks={trucks} />}
      {open === "remove" && <RemoveForm user={user} isSelf={isSelf} selfEmail={selfEmail} />}
    </div>
  );
}

function EditForm({ user, trucks }: { user: StaffUser; trucks: TruckOption[] }) {
  const [state, action] = useFormState(editUserAction, init);
  const [driver, setDriver] = useState(!!user.driverId && user.driverActive);
  const access = user.role === "owner" || user.role === "staff" ? user.role : "none";

  return (
    <form action={action} className="flex flex-col gap-3 border-t-2 border-line p-3">
      <input type="hidden" name="id" value={user.id} />
      <div className="grid gap-3 md:grid-cols-3">
        <label className={labelCls}>
          Name
          <input name="full_name" defaultValue={user.fullName ?? ""} required className={inputCls} />
        </label>
        <label className={labelCls}>
          Phone
          <input name="phone" defaultValue={user.phone ?? ""} className={inputCls} />
        </label>
        <label className={labelCls}>
          Access
          <select name="access" defaultValue={access} className={inputCls}>
            <option value="staff">Staff</option>
            <option value="owner">Owner</option>
            <option value="none">No office access (driver only)</option>
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-[13px] font-semibold">
        <input type="checkbox" name="driver" checked={driver} onChange={(e) => setDriver(e.target.checked)} />
        Driver access
      </label>
      {driver && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className={labelCls}>
            Truck
            <select name="truck_id" defaultValue={user.truckId ?? ""} className={inputCls}>
              <option value="">No truck</option>
              {trucks.map((t) => (
                <option key={t.id} value={t.id} disabled={!!t.assigned_driver_id && t.assigned_driver_id !== user.driverId}>
                  {t.nickname}
                  {t.assigned_driver_id && t.assigned_driver_id !== user.driverId ? " (assigned)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Vehicle notes
            <input name="vehicle_info" defaultValue={user.vehicleInfo ?? ""} className={inputCls} />
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Submit label="Save" pending="Saving…" cls="bg-teal px-4 py-2 text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60" />
        <Result state={state} />
      </div>
    </form>
  );
}

function RemoveForm({ user, isSelf, selfEmail }: { user: StaffUser; isSelf: boolean; selfEmail: string | null }) {
  const [state, action] = useFormState(removeUserAction, init);
  return (
    <form action={action} className="flex flex-col gap-3 border-t-2 border-line p-3 text-[13px]">
      <input type="hidden" name="id" value={user.id} />
      <p>
        {isSelf
          ? "Remove yourself? Your access is cleared and your login is blocked. Another owner can restore you later."
          : `Remove ${user.fullName ?? user.email}? Their access is cleared and their login is blocked. The record and its history are kept, and you can restore it later.`}
      </p>
      {isSelf && (
        <label className={labelCls}>
          Type your email ({selfEmail}) to confirm — you&apos;ll be signed out
          <input name="confirm_email" autoComplete="off" className={inputCls} required />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Submit label={isSelf ? "Remove me" : "Remove"} pending="Removing…" cls={dangerBtn} />
        <Result state={state} />
      </div>
    </form>
  );
}

function InviteControls({ id }: { id: string }) {
  const [resendState, resend] = useFormState(resendInviteAction, init);
  const [revokeState, revoke] = useFormState(revokeInviteAction, init);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <form action={resend}>
          <input type="hidden" name="id" value={id} />
          <Submit label="Resend" pending="Sending…" cls={btn} />
        </form>
        <form action={revoke}>
          <input type="hidden" name="id" value={id} />
          <Submit label="Revoke" pending="Revoking…" cls={dangerBtn} />
        </form>
      </div>
      <Result state={resendState.error || resendState.message ? resendState : revokeState} />
    </div>
  );
}

function RestoreControl({ id }: { id: string }) {
  const [state, action] = useFormState(restoreUserAction, init);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={id} />
      <Submit label="Restore" pending="Restoring…" cls={btn} />
      <Result state={state} />
    </form>
  );
}
