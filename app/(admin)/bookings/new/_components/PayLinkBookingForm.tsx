"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import type { PricingConfig } from "@/lib/bookings/pricing";
import { NO_REACHABLE_CONTACT, reachable } from "@/lib/pay-links/contact";
import { createStaffBookingAction, type BookingActionState } from "../../actions";
import { createPayLinkBookingAction, type PayLinkBookingState } from "../pay-link-actions";
import { PayLinkResult } from "../../_components/PayLinkResult";
import { BookingFormLayout, type FormCustomer, type FormReadiness } from "./NewBookingForm";

const payInit: PayLinkBookingState = { ok: false };
const plainInit: BookingActionState = { ok: false };

/** What staff say before ticking the texts box (shown only with pay links on). */
export const CONSENT_SCRIPT =
  "Ask: “Can we text you the payment link and updates about this booking? Reply STOP any time to stop texts.” Tick only if they say yes.";

function BookButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={disabled || pending}
      className="self-start bg-teal px-4 py-2.5 text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "Booking…" : "Book and send pay link"}
    </button>
  );
}

function PlainButton({ disabled, formAction }: { disabled: boolean; formAction: (fd: FormData) => void }) {
  const { pending } = useFormStatus();
  return (
    <button
      formAction={formAction}
      disabled={disabled || pending}
      className="self-start border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
    >
      Create unpaid without a pay link
    </button>
  );
}

/**
 * The submit area with pay links on. Pure apart from the pending flag, so its
 * states can be rendered in tests.
 */
export function PayLinkSubmitArea({
  readiness,
  error,
  plainError,
  plainAction,
}: {
  readiness: FormReadiness;
  error?: string;
  plainError?: string;
  plainAction: (fd: FormData) => void;
}) {
  const canReach = reachable(readiness);
  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-[12px] font-semibold text-orange-tint-ink">{error}</p>}
      <BookButton disabled={!readiness.ready || !canReach} />
      {readiness.ready && !canReach && (
        <p className="text-[12px] font-semibold text-orange-tint-ink" data-testid="book-disabled-reason">
          {NO_REACHABLE_CONTACT}
        </p>
      )}
      <div className="mt-1 flex flex-col gap-1 border-t-2 border-line pt-2">
        {plainError && <p className="text-[12px] font-semibold text-orange-tint-ink">{plainError}</p>}
        <PlainButton disabled={!readiness.ready} formAction={plainAction} />
        <p className="text-[11px] text-ink-3">
          For cash or check on delivery. A booking made this way gets no pay link and no payment reminders.
        </p>
      </div>
    </div>
  );
}

/** Staff booking form with pay links on: Book creates the booking and sends the link in one step. */
export function PayLinkBookingForm({
  pricing,
  customer,
}: {
  pricing: PricingConfig;
  customer: FormCustomer | null;
}) {
  const [state, action] = useFormState(createPayLinkBookingAction, payInit);
  const [plainState, plainAction] = useFormState(createStaffBookingAction, plainInit);

  if (state.ok && state.bookingId) {
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <PayLinkResult title="Booked — pay link issued." sent={state.sent ?? []} url={state.url} />
        <div className="flex gap-3 text-[13px] font-extrabold">
          <Link href={`/bookings/${state.bookingId}`} className="underline">
            Open the booking →
          </Link>
          <a href="/bookings/new" className="underline">
            Book another
          </a>
        </div>
      </div>
    );
  }

  return (
    <BookingFormLayout
      pricing={pricing}
      customer={customer}
      action={action}
      consentScript={<p className="pl-6 text-[12px] font-semibold text-ink">{CONSENT_SCRIPT}</p>}
      summaryNote={
        <p className="text-[11px] text-ink-3">
          Book sends the customer a link to pay this amount by card — by email, and by text if they agreed.
          Reminders follow if it stays unpaid.
        </p>
      }
      renderSubmit={(r) => (
        <PayLinkSubmitArea readiness={r} error={state.error} plainError={plainState.error} plainAction={plainAction} />
      )}
    />
  );
}
