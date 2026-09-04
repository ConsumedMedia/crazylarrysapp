"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  submitChangeRequestAction,
  cancelChangeRequestAction,
  type ChangeRequestActionState,
} from "../actions";
import type { ChangeRequestRow } from "@/lib/bookings/change-requests";
import { parseYmd } from "@/lib/availability/dates";
import type { DumpsterSize } from "@/lib/dumpsters/state-machine";
import { ChangeDateCalendar } from "./ChangeDateCalendar";

const init: ChangeRequestActionState = { ok: false };

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function diffDays(from: string, to: string): number {
  return Math.round((parseYmd(to).getTime() - parseYmd(from).getTime()) / 86_400_000);
}

const STATUS_LABEL: Record<ChangeRequestRow["status"], string> = {
  pending: "Pending review",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Withdrawn",
};

const STATUS_CLASS: Record<ChangeRequestRow["status"], string> = {
  pending: "bg-purple-tint text-purple-tint-ink",
  approved: "bg-teal-tint text-teal-tint-ink",
  declined: "bg-orange-tint text-orange-tint-ink",
  cancelled: "bg-tint text-ink-2",
};

function Pending({ children }: { children: (p: boolean) => React.ReactNode }) {
  const { pending } = useFormStatus();
  return <>{children(pending)}</>;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="bg-teal px-4 py-2.5 text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "Sending…" : "Send request"}
    </button>
  );
}

function DateField({
  label,
  size,
  currentDate,
  value,
  onSelect,
  onClear,
}: {
  label: string;
  size: DumpsterSize;
  currentDate: string;
  value: string | null;
  onSelect: (date: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          {label}
        </span>
        {value ? (
          <div className="flex items-center gap-2">
            <span className="cl-nums text-[13px] font-bold text-teal-tint-ink">
              {fmt(value)}
            </span>
            <button
              type="button"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="text-[11px] font-extrabold text-ink-3 hover:text-ink"
            >
              Clear
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] font-extrabold text-pink hover:underline"
          >
            {open ? "Hide calendar" : "+ Pick a date"}
          </button>
        )}
      </div>
      {open && !value && (
        <ChangeDateCalendar
          size={size}
          currentDate={currentDate}
          value={value}
          onSelect={(d) => {
            onSelect(d);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function NewRequestForm({
  bookingId,
  size,
  currentDeliveryDate,
  currentPickupDate,
  extraDayRate,
}: {
  bookingId: string;
  size: DumpsterSize;
  currentDeliveryDate: string;
  currentPickupDate: string;
  extraDayRate: number;
}) {
  const [state, formAction] = useFormState(submitChangeRequestAction, init);
  const [deliveryDate, setDeliveryDate] = useState<string | null>(null);
  const [pickupDate, setPickupDate] = useState<string | null>(null);

  const costImpact = useMemo(() => {
    if (!pickupDate || pickupDate === currentPickupDate) return null;
    const extra = diffDays(currentPickupDate, pickupDate);
    if (extra <= 0) return { extra, amount: 0 };
    return { extra, amount: extra * extraDayRate };
  }, [pickupDate, currentPickupDate, extraDayRate]);

  const hasChange = !!deliveryDate || !!pickupDate;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="requestedDeliveryDate" value={deliveryDate ?? ""} />
      <input type="hidden" name="requestedPickupDate" value={pickupDate ?? ""} />

      <div className="grid gap-4 sm:grid-cols-2">
        <DateField
          label="New delivery date"
          size={size}
          currentDate={currentDeliveryDate}
          value={deliveryDate}
          onSelect={setDeliveryDate}
          onClear={() => setDeliveryDate(null)}
        />
        <DateField
          label="New pickup date"
          size={size}
          currentDate={currentPickupDate}
          value={pickupDate}
          onSelect={setPickupDate}
          onClear={() => setPickupDate(null)}
        />
      </div>

      {costImpact && (
        <div
          className={`border-2 px-3 py-2.5 text-[13px] ${
            costImpact.amount > 0
              ? "border-orange bg-orange-tint text-orange-tint-ink"
              : "border-line bg-tint text-ink-2"
          }`}
        >
          {costImpact.amount > 0 ? (
            <>
              <strong>
                {costImpact.extra} extra day{costImpact.extra === 1 ? "" : "s"} at $
                {extraDayRate.toFixed(2)} = ${costImpact.amount.toFixed(2)}.
              </strong>{" "}
              Only charged if the office approves the new date. Nothing is
              charged for asking.
            </>
          ) : (
            "This pickup date is earlier than currently scheduled — no extra charge."
          )}
        </div>
      )}

      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Why?
        <textarea
          name="reason"
          required
          rows={3}
          className="border-2 border-line bg-bg px-3 py-2 text-[13px] font-medium normal-case tracking-normal text-ink"
        />
      </label>
      {state.error && (
        <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>
      )}
      {state.ok && state.message && (
        <p className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</p>
      )}
      <SubmitButton disabled={!hasChange} />
    </form>
  );
}

function CancelButton({ id, bookingId }: { id: string; bookingId: string }) {
  const [state, formAction] = useFormState(cancelChangeRequestAction, init);
  return (
    <form action={formAction} className="mt-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <Pending>
        {(p) => (
          <button
            disabled={p}
            className="border-2 border-line px-2.5 py-1 text-[11px] font-extrabold hover:border-ink disabled:opacity-60"
          >
            {p ? "Withdrawing…" : "Withdraw request"}
          </button>
        )}
      </Pending>
      {state.error && (
        <p className="mt-1 text-[11px] font-semibold text-orange-tint-ink">{state.error}</p>
      )}
    </form>
  );
}

export function RequestChangeForm({
  bookingId,
  size,
  currentDeliveryDate,
  currentPickupDate,
  extraDayRate,
  canRequest,
  closedReason,
  requests,
}: {
  bookingId: string;
  size: DumpsterSize;
  currentDeliveryDate: string;
  currentPickupDate: string;
  extraDayRate: number;
  canRequest: boolean;
  closedReason: string | null;
  requests: ChangeRequestRow[];
}) {
  const hasPending = requests.some((r) => r.status === "pending");

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
        Request a change
      </div>
      <div className="flex flex-col gap-4 p-4">
        {requests.length > 0 && (
          <ul className="flex flex-col gap-3">
            {requests.map((r) => (
              <li key={r.id} className="border-2 border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-2 py-0.5 text-[10px] font-extrabold uppercase ${STATUS_CLASS[r.status]}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  <span className="text-[11px] text-ink-3">
                    {new Date(r.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="mt-1.5 text-[13px]">
                  {r.requested_delivery_date && (
                    <div>New delivery: {fmt(r.requested_delivery_date)}</div>
                  )}
                  {r.requested_pickup_date && (
                    <div>New pickup: {fmt(r.requested_pickup_date)}</div>
                  )}
                  <div className="mt-1 text-ink-2">&ldquo;{r.reason}&rdquo;</div>
                  {r.staff_response && (
                    <div className="mt-1.5 border-l-2 border-line pl-2 text-ink-2">
                      Staff: {r.staff_response}
                    </div>
                  )}
                </div>
                {r.status === "pending" && (
                  <CancelButton id={r.id} bookingId={bookingId} />
                )}
              </li>
            ))}
          </ul>
        )}

        {!canRequest ? (
          <p className="text-[12px] text-ink-2">{closedReason}</p>
        ) : hasPending ? (
          <p className="text-[12px] text-ink-2">
            You have a pending request — we&apos;ll get back to you before you
            can submit another.
          </p>
        ) : (
          <NewRequestForm
            bookingId={bookingId}
            size={size}
            currentDeliveryDate={currentDeliveryDate}
            currentPickupDate={currentPickupDate}
            extraDayRate={extraDayRate}
          />
        )}
      </div>
    </section>
  );
}
