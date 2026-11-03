"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { payAndBookAction } from "../actions";
import type { CreateBookingInput } from "@/lib/bookings/types";
import { CardFields, useCardToken } from "@/lib/payments/CardFields";

/**
 * PCI note: the card fields below live on our page, but their values are sent
 * by fetch() DIRECTLY to Intuit's tokenization endpoint (`tokenizeUrl`). The
 * only thing that ever reaches our server is the opaque token string. Card
 * number / CVC / expiry are never in a request to our backend, never logged.
 * The fields and tokenization are shared with /pay (lib/payments/CardFields).
 */

export function PaymentForm({
  tokenizeUrl,
  total,
  disabled,
  disabledReason,
  buildInput,
  onRefused,
}: {
  tokenizeUrl: string;
  total: number | null;
  disabled: boolean;
  disabledReason?: string;
  buildInput: () => (CreateBookingInput & { agreementAcknowledged: boolean }) | null;
  /** Moves the customer to the step that owns the refusal; false = stay here. */
  onRefused: (code: string | undefined, reason: string | undefined, message: string) => boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notCharged, setNotCharged] = useState<string | null>(null);
  const card = useCardToken(tokenizeUrl);

  function submit() {
    setError(null);
    setNotCharged(null);
    const bookingInput = buildInput();
    if (!bookingInput) {
      setError("Some booking details are missing. Go back and complete them.");
      return;
    }
    startTransition(async () => {
      let token: string;
      try {
        token = await card.tokenize();
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      const idempotencyKey =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const res = await payAndBookAction({
        ...bookingInput,
        paymentToken: token,
        idempotencyKey,
      });

      if (res.ok && res.bookingId) {
        router.push(`/book/confirmed/${res.bookingId}`);
        return;
      }
      const compensated = res.code === "compensated";
      const message =
        res.error ?? (compensated ? "You were not charged." : "Payment failed. Try again.");
      // The wizard shows the message on the step it moves to; this form
      // unmounts when the step changes.
      if (onRefused(res.code, res.reason, message)) return;
      if (compensated) setNotCharged(message);
      else setError(message);
    });
  }

  return (
    <div className="border-2 border-line-strong bg-surface">
      <div className="flex items-center justify-between border-b-2 border-line-strong px-4 py-3">
        <span className="text-[11px] font-extrabold uppercase tracking-[0.16em]">
          Card payment
        </span>
        <span className="bg-[#2ca01c] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-white">
          QuickBooks Payments
        </span>
      </div>

      <div className="flex flex-col gap-3.5 p-4">
        <p className="text-[12px] text-ink-3">
          Card details go straight to QuickBooks Payments — they never touch
          Larry&apos;s servers.
        </p>

        <CardFields card={card} />

        <button
          disabled={pending || disabled || !card.cardValid || !total}
          onClick={submit}
          className="mt-1 flex w-full items-center justify-between bg-teal px-4 py-4 text-[15px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {pending
            ? "Charging…"
            : total
              ? `Pay $${total.toFixed(2)} & book it`
              : "Pay & book it"}
          <span>→</span>
        </button>

        {disabled && disabledReason && !error && (
          <p className="text-[12px] text-ink-3">{disabledReason}</p>
        )}
        {notCharged && (
          <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink">
            {notCharged}
          </p>
        )}
        {error && (
          <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
