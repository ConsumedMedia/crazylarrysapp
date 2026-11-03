"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AgreementModal } from "@/app/(customer)/book/_components/AgreementModal";
import { CardFields, useCardToken } from "@/lib/payments/CardFields";
import { payLinkAction } from "./actions";

/**
 * Agreement (the same self-attest step as /book), an optional "text me
 * updates" opt-in, and the card. No booking fields: date, size and price come
 * from the saved booking and can't be changed here. The double-click guard is
 * on the server (one charge in flight per link); the button is also disabled
 * while a submit is pending.
 */
export function PayLinkForm({
  token,
  total,
  size,
  docusignUrl,
  tokenizeUrl,
  paymentsReady,
}: {
  token: string;
  total: number;
  size: string;
  docusignUrl: string | null;
  tokenizeUrl: string;
  paymentsReady: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notCharged, setNotCharged] = useState<string | null>(null);
  const card = useCardToken(tokenizeUrl);

  function submit() {
    setError(null);
    setNotCharged(null);
    startTransition(async () => {
      let paymentToken: string;
      try {
        paymentToken = await card.tokenize();
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      const res = await payLinkAction({ token, paymentToken, expectedTotal: total, agreement: agreed, smsOptIn });
      if (res.ok) {
        router.refresh(); // the page re-renders as "paid"
        return;
      }
      if (res.code === "amount_changed") {
        setError(res.message ?? "The amount changed. Check it and try again.");
        router.refresh();
        return;
      }
      if (res.code === "compensated") setNotCharged(res.message ?? "You have not been charged.");
      else setError(res.message ?? "Payment failed. Try again.");
    });
  }

  const blocked = !paymentsReady ? "Card payments aren't available right now — please call the yard." : !agreed ? "Read and accept the rental agreement first." : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="border-2 border-line-strong bg-surface p-4">
        <div className="text-[11px] font-extrabold uppercase tracking-[0.16em]">Rental agreement</div>
        <p className="mt-1.5 text-[13px] text-ink-2">
          {agreed ? "Thanks — you've accepted the rental agreement." : "Please read and complete the rental agreement before paying."}
        </p>
        <button
          type="button"
          onClick={() => setAgreementOpen(true)}
          className="mt-3 border-2 border-line-strong px-3 py-2 text-[13px] font-extrabold hover:border-ink"
        >
          {agreed ? "View the agreement" : "Open the agreement"}
        </button>
      </section>

      <div className="border-2 border-line-strong bg-surface">
        <div className="flex items-center justify-between border-b-2 border-line-strong px-4 py-3">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.16em]">Card payment</span>
          <span className="bg-[#2ca01c] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-white">
            QuickBooks Payments
          </span>
        </div>
        <div className="flex flex-col gap-3.5 p-4">
          <p className="text-[12px] text-ink-3">
            Card details go straight to QuickBooks Payments — they never touch Larry&apos;s servers.
          </p>
          <CardFields card={card} />

          <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
            <input
              type="checkbox"
              checked={smsOptIn}
              onChange={(e) => setSmsOptIn(e.target.checked)}
              className="mt-0.5 h-4 w-4 flex-none accent-teal"
            />
            <span>
              Text me updates about this rental (delivery, pickup). Message and data rates may apply. Reply STOP to
              opt out.
            </span>
          </label>

          <button
            disabled={pending || !!blocked || !card.cardValid}
            onClick={submit}
            className="mt-1 flex w-full items-center justify-between bg-teal px-4 py-4 text-[15px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {pending ? "Charging…" : `Pay $${total.toFixed(2)}`}
            <span>→</span>
          </button>

          {blocked && !error && <p className="text-[12px] text-ink-3">{blocked}</p>}
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

      <AgreementModal
        open={agreementOpen}
        onClose={() => setAgreementOpen(false)}
        onAcknowledge={setAgreed}
        acknowledged={agreed}
        size={size}
        docusignUrl={docusignUrl}
      />
    </div>
  );
}
