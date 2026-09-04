"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import {
  cancelChangeRequestAction,
  type ChangeRequestActionState,
} from "../bookings/[id]/actions";
import type { MyPendingChangeRequestRow } from "@/lib/bookings/change-requests";

const init: ChangeRequestActionState = { ok: false };

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="whitespace-nowrap border-2 border-ink px-3 py-1.5 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
    >
      {pending ? "Withdrawing…" : "Withdraw"}
    </button>
  );
}

function WithdrawButton({ id, bookingId }: { id: string; bookingId: string }) {
  const [state, formAction] = useFormState(cancelChangeRequestAction, init);
  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <SubmitButton />
      {state.error && (
        <span className="text-[11px] font-semibold text-orange-tint-ink">
          {state.error}
        </span>
      )}
    </form>
  );
}

export function PendingRequestBanner({
  requests,
}: {
  requests: MyPendingChangeRequestRow[];
}) {
  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {requests.map((r) => (
        <div
          key={r.id}
          className="flex flex-wrap items-center gap-3.5 border-2 border-purple bg-surface p-4"
        >
          <span className="grid h-8 w-8 flex-none place-items-center bg-purple text-white">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.3"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <div className="min-w-[200px] flex-1">
            <div className="text-[14px] font-extrabold">
              Change requested — waiting on the office
            </div>
            <div className="text-[13px] leading-snug text-ink-2">
              {r.requested_pickup_date && (
                <>New pickup {fmt(r.requested_pickup_date)}</>
              )}
              {r.requested_pickup_date && r.requested_delivery_date && " · "}
              {r.requested_delivery_date && (
                <>New delivery {fmt(r.requested_delivery_date)}</>
              )}{" "}
              on <Link href={`/account/bookings/${r.booking_id}`} className="underline">
                {r.booking_delivery_address}
              </Link>
              . Submitted {new Date(r.created_at).toLocaleDateString()}.
            </div>
          </div>
          <span className="whitespace-nowrap bg-purple-tint px-2.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.06em] text-purple-tint-ink">
            Pending approval
          </span>
          <WithdrawButton id={r.id} bookingId={r.booking_id} />
        </div>
      ))}
    </div>
  );
}
