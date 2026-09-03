"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { payAndBookAction } from "../actions";
import type { CreateBookingInput } from "@/lib/bookings/types";

/**
 * PCI note: the card fields below live on our page, but their values are sent
 * by fetch() DIRECTLY to Intuit's tokenization endpoint (`tokenizeUrl`). The
 * only thing that ever reaches our server is the opaque token string. Card
 * number / CVC / expiry are never in a request to our backend, never logged.
 */

function onlyDigits(s: string): string {
  return s.replace(/\D+/g, "");
}

const input =
  "w-full border-2 border-line bg-bg px-3 py-2.5 text-[15px] text-ink cl-nums";
const label =
  "flex flex-col gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink-2";

export function PaymentForm({
  tokenizeUrl,
  total,
  disabled,
  disabledReason,
  buildInput,
  onCompensated,
}: {
  tokenizeUrl: string;
  total: number | null;
  disabled: boolean;
  disabledReason?: string;
  buildInput: () => (CreateBookingInput & { agreementAcknowledged: boolean }) | null;
  onCompensated: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notCharged, setNotCharged] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [zip, setZip] = useState("");

  const cardValid =
    name.trim().length > 1 &&
    onlyDigits(number).length >= 13 &&
    /^\d{1,2}$/.test(expMonth) &&
    Number(expMonth) >= 1 &&
    Number(expMonth) <= 12 &&
    /^\d{2}$/.test(expYear) &&
    onlyDigits(cvc).length >= 3 &&
    onlyDigits(zip).length >= 5;

  async function tokenizeCard(): Promise<string> {
    const res = await fetch(tokenizeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        card: {
          name: name.trim(),
          number: onlyDigits(number),
          expMonth: expMonth.padStart(2, "0"),
          expYear: `20${expYear}`,
          cvc: onlyDigits(cvc),
          address: {
            postalCode: onlyDigits(zip),
            country: "US",
          },
        },
      }),
    });
    if (!res.ok) {
      let msg = "We couldn't read that card. Check the number and try again.";
      try {
        const j = await res.json();
        if (j?.errors?.[0]?.detail) msg = `Card error: ${j.errors[0].detail}`;
      } catch {
        /* keep default */
      }
      throw new Error(msg);
    }
    const j = await res.json();
    if (!j?.value) throw new Error("Card tokenization failed. Try again.");
    return j.value as string;
  }

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
        token = await tokenizeCard();
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
      if (res.code === "compensated") {
        setNotCharged(res.error ?? "You were not charged.");
        onCompensated();
        return;
      }
      setError(res.error ?? "Payment failed. Try again.");
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

        <label className={label}>
          Name on card
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="cc-name"
            className={input}
          />
        </label>
        <label className={label}>
          Card number
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="4111 1111 1111 1111"
            className={input}
          />
        </label>
        <div className="grid grid-cols-[1fr_1fr_1fr_1.2fr] gap-3">
          <label className={label}>
            MM
            <input
              value={expMonth}
              onChange={(e) => setExpMonth(onlyDigits(e.target.value).slice(0, 2))}
              inputMode="numeric"
              autoComplete="cc-exp-month"
              placeholder="09"
              className={input}
            />
          </label>
          <label className={label}>
            YY
            <input
              value={expYear}
              onChange={(e) => setExpYear(onlyDigits(e.target.value).slice(0, 2))}
              inputMode="numeric"
              autoComplete="cc-exp-year"
              placeholder="30"
              className={input}
            />
          </label>
          <label className={label}>
            CVC
            <input
              value={cvc}
              onChange={(e) => setCvc(onlyDigits(e.target.value).slice(0, 4))}
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder="123"
              className={input}
            />
          </label>
          <label className={label}>
            Billing ZIP
            <input
              value={zip}
              onChange={(e) => setZip(onlyDigits(e.target.value).slice(0, 5))}
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="43004"
              className={input}
            />
          </label>
        </div>

        <button
          disabled={pending || disabled || !cardValid || !total}
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
