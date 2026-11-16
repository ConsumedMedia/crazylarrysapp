"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { SmsReview, SmsReviewOutcome } from "@/lib/sms-inbound/reviews";
import { formatYardDateTime } from "@/lib/time/yard";
import { resolveSmsReviewAction, type ResolveState } from "../actions";

const init: ResolveState = { ok: false };

function Choice({ label, primary }: { label: string; primary?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className={
        primary
          ? "bg-ink px-2 py-1 text-[11px] font-extrabold text-surface disabled:opacity-60"
          : "border-2 border-line px-2 py-1 text-[11px] font-extrabold hover:border-ink disabled:opacity-60"
      }
    >
      {pending ? "…" : label}
    </button>
  );
}

const CHOICES: Record<SmsReview["reason"], Array<{ outcome: SmsReviewOutcome; label: string; primary?: boolean }>> = {
  cancel_keyword: [{ outcome: "checked", label: "Checked", primary: true }],
  keyword_in_message: [
    { outcome: "treated_as_stop", label: "Treat as STOP", primary: true },
    { outcome: "not_a_stop", label: "Not a STOP" },
  ],
};

/** One flagged text. Pure apart from the pending flag; `action` comes from the caller. */
export function SmsReviewItemView({ review, action }: { review: SmsReview; action: (fd: FormData) => void }) {
  const who =
    review.customers.length > 0
      ? review.customers.map((c) => c.name).join(", ")
      : review.numberHint
        ? `a number ending ${review.numberHint} (no customer)`
        : "an unknown number";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-extrabold">
          {review.reason === "cancel_keyword" ? "Texted CANCEL" : `Text mentions ${review.keyword}`} — {who}
        </span>
        <span className="cl-nums">{formatYardDateTime(review.receivedAt)}</span>
      </div>
      {review.reason === "cancel_keyword" ? (
        <div>Texts to this number have stopped. Check whether they meant to cancel a booking.</div>
      ) : (
        <>
          {review.text && <blockquote className="border-l-2 border-orange pl-2 italic" data-testid="sms-review-text">{review.text}</blockquote>}
          <div>Texts to this number are on hold until you choose.</div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {CHOICES[review.reason].map((c) => (
          <form key={c.outcome} action={action}>
            <input type="hidden" name="id" value={review.id} />
            <input type="hidden" name="outcome" value={c.outcome} />
            <Choice label={c.label} primary={c.primary} />
          </form>
        ))}
      </div>
    </div>
  );
}

export function SmsReviewItem({ review }: { review: SmsReview }) {
  const [state, action] = useFormState(resolveSmsReviewAction, init);
  if (state.ok) return <span className="text-[11px] font-extrabold text-teal-tint-ink">Done</span>;
  return (
    <div className="flex flex-col gap-1">
      <SmsReviewItemView review={review} action={action} />
      {state.error && <span className="text-[11px] font-semibold text-orange-tint-ink">{state.error}</span>}
    </div>
  );
}
