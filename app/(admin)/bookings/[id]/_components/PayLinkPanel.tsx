"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { PayLinkState, PayLinkSummary, PayLinkDelivery } from "@/lib/pay-links/booking-state";
import { outcomeLine, PayLinkResult } from "../../_components/PayLinkResult";
import { resendPayLinkAction, type ResendState } from "../pay-link-actions";

const init: ResendState = { ok: false };

const ENDED: Record<string, string> = {
  booking_cancelled: "booking cancelled",
  paid_other_path: "paid another way",
  payment_status_changed: "payment status changed",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function linkLine(l: PayLinkSummary): string {
  if (l.status === "paid") return `Paid ${when(l.paidAt)}`;
  if (l.status === "superseded") return `Replaced by a newer link ${when(l.endedAt)}`;
  if (l.status === "ended") return `Ended ${when(l.endedAt)}${l.endedReason ? ` — ${ENDED[l.endedReason] ?? l.endedReason}` : ""}`;
  return "Live";
}

function deliveryLine(d: PayLinkDelivery): string {
  const base = outcomeLine({ channel: d.channel, status: d.status, category: d.category, redirected: d.redirected });
  return `${d.type === "pay_link_reminder" ? "Reminder · " : ""}${base} · ${when(d.at)}`;
}

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="bg-orange px-3 py-2 text-[12px] font-extrabold text-white hover:opacity-90 disabled:opacity-60"
    >
      {pending ? "Sending…" : "Yes, send a new link"}
    </button>
  );
}

/**
 * Send / Resend with an inline two-step confirm (no window.confirm). Pure
 * apart from the pending flag; `stage` and the handlers come from the caller.
 */
export function ResendBlock({
  bookingId,
  hasActive,
  stage,
  onAsk,
  onCancel,
  action,
}: {
  bookingId: string;
  hasActive: boolean;
  stage: "idle" | "confirm";
  onAsk: () => void;
  onCancel: () => void;
  action: (fd: FormData) => void;
}) {
  if (stage === "idle") {
    return (
      <button
        type="button"
        onClick={onAsk}
        className="self-start border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint"
      >
        {hasActive ? "Resend pay link" : "Send pay link"}
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 border-l-4 border-orange bg-orange-tint p-2.5" data-testid="resend-confirm">
      <input type="hidden" name="id" value={bookingId} />
      <p className="text-[12px] font-semibold text-orange-tint-ink">
        {hasActive
          ? "This makes a new link and sends it. The old link stops working right away — if the customer opens it, they'll be told to use the new one."
          : "This makes a pay link and sends it to the customer."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Confirm />
        <button
          type="button"
          onClick={onCancel}
          className="border-2 border-line px-3 py-2 text-[12px] font-extrabold hover:border-ink"
        >
          {hasActive ? "Keep the current link" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

/**
 * The booking page's pay-link panel. Shown when a link is live (whether or not
 * pay links are on), or when pay links are on. With pay links off and no live
 * link the page doesn't render it at all.
 */
export function PayLinkPanel({
  bookingId,
  state: s,
  enabled,
  canIssue,
}: {
  bookingId: string;
  state: PayLinkState;
  enabled: boolean;
  /** Unpaid and open: a link may be issued (the database checks again). */
  canIssue: boolean;
}) {
  const [stage, setStage] = useState<"idle" | "confirm">("idle");
  const [result, action] = useFormState(resendPayLinkAction, init);
  const a = s.active;
  const older = s.links.filter((l) => l !== a);

  return (
    <section className="border-2 border-line-strong bg-surface" data-testid="pay-link-panel">
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-line-strong px-4 py-3">
        <span className="text-[15px] font-extrabold">Pay link</span>
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${
            a ? (a.chargeStartedAt ? "bg-orange-tint text-orange-tint-ink" : "bg-teal-tint text-teal-tint-ink") : "bg-tint text-ink-2"
          }`}
        >
          {a ? (a.chargeStartedAt ? "Payment in progress" : "Live") : "None live"}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4 text-[13px]">
        {a ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-2">Sent</dt>
            <dd className="font-bold">
              {when(a.createdAt)}
              {a.createdByName ? ` by ${a.createdByName}` : ""}
            </dd>
            <dt className="text-ink-2">Reminders</dt>
            <dd className="font-bold">
              {s.remindersSent === 0 ? "None yet" : `${s.remindersSent} sent · last ${when(s.lastReminderAt)}`}
            </dd>
            <dt className="text-ink-2">Agreement</dt>
            <dd className="font-bold">{a.agreementAckAt ? `Accepted ${when(a.agreementAckAt)}` : "Not opened yet"}</dd>
          </dl>
        ) : (
          <p className="text-ink-2">No pay link is live for this booking.</p>
        )}

        {s.deliveries.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">Channels</div>
            <ul className="flex flex-col gap-0.5 text-[12px]">
              {s.deliveries.map((d, i) => (
                <li key={i}>{deliveryLine(d)}</li>
              ))}
            </ul>
          </div>
        )}

        {!enabled && a && (
          <p className="text-[12px] font-semibold text-ink-2">
            Pay links are off: this link still works, but no reminders go out and it can&apos;t be resent.
          </p>
        )}

        {result.ok && (
          <PayLinkResult title={a ? "New link issued." : "Pay link issued."} sent={result.sent ?? []} url={result.url} />
        )}
        {result.error && <p className="text-[12px] font-semibold text-orange-tint-ink">{result.error}</p>}

        {enabled && canIssue && (
          <ResendBlock
            bookingId={bookingId}
            hasActive={!!a}
            stage={stage}
            onAsk={() => setStage("confirm")}
            onCancel={() => setStage("idle")}
            action={(fd) => {
              setStage("idle");
              action(fd);
            }}
          />
        )}

        {older.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">Earlier links</div>
            <ul className="flex flex-col gap-0.5 text-[12px] text-ink-2">
              {older.map((l) => (
                <li key={l.id}>
                  {when(l.createdAt)} — {linkLine(l)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
