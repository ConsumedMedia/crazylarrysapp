"use client";

import { useState } from "react";
import { cardLooksValid, onlyDigits, tokenizeCard, type CardValues } from "./card-token";

/**
 * Card-entry state + tokenization, shared by /book's PaymentForm and /pay.
 * Values stay in this component's state and go only to Intuit (see
 * card-token.ts); callers get the opaque token from `tokenize()`.
 */
export function useCardToken(tokenizeUrl: string) {
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [zip, setZip] = useState("");
  const values: CardValues = { name, number, expMonth, expYear, cvc, zip };
  return {
    values,
    set: { name: setName, number: setNumber, expMonth: setExpMonth, expYear: setExpYear, cvc: setCvc, zip: setZip },
    cardValid: cardLooksValid(values),
    tokenize: () => tokenizeCard(tokenizeUrl, values),
  };
}

export type CardToken = ReturnType<typeof useCardToken>;

const input =
  "w-full border-2 border-line bg-bg px-3 py-2.5 text-[15px] text-ink cl-nums";
const label =
  "flex flex-col gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink-2";

/** The card inputs (name, number, MM, YY, CVC, billing ZIP). */
export function CardFields({ card }: { card: CardToken }) {
  const { values: v, set } = card;
  return (
    <>
      <label className={label}>
        Name on card
        <input
          value={v.name}
          onChange={(e) => set.name(e.target.value)}
          autoComplete="cc-name"
          className={input}
        />
      </label>
      <label className={label}>
        Card number
        <input
          value={v.number}
          onChange={(e) => set.number(e.target.value)}
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
            value={v.expMonth}
            onChange={(e) => set.expMonth(onlyDigits(e.target.value).slice(0, 2))}
            inputMode="numeric"
            autoComplete="cc-exp-month"
            placeholder="09"
            className={input}
          />
        </label>
        <label className={label}>
          YY
          <input
            value={v.expYear}
            onChange={(e) => set.expYear(onlyDigits(e.target.value).slice(0, 2))}
            inputMode="numeric"
            autoComplete="cc-exp-year"
            placeholder="30"
            className={input}
          />
        </label>
        <label className={label}>
          CVC
          <input
            value={v.cvc}
            onChange={(e) => set.cvc(onlyDigits(e.target.value).slice(0, 4))}
            inputMode="numeric"
            autoComplete="cc-csc"
            placeholder="123"
            className={input}
          />
        </label>
        <label className={label}>
          Billing ZIP
          <input
            value={v.zip}
            onChange={(e) => set.zip(onlyDigits(e.target.value).slice(0, 5))}
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="43004"
            className={input}
          />
        </label>
      </div>
    </>
  );
}
