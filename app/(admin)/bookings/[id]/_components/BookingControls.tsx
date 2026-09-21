"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  BOOKING_STATUS_META,
  DOCUSIGN_STATUSES,
  DOCUSIGN_META,
  nextBookingStatuses,
  type BookingStatus,
  type DocusignStatus,
} from "@/lib/bookings/state-machine";
import {
  changeStatusAction,
  setAgreementAction,
  refundAction,
  applyDrivewayFeeAction,
  removeDrivewayFeeAction,
  type BookingActionState,
} from "../../actions";

const init: BookingActionState = { ok: false };

function Pending({ children }: { children: (p: boolean) => React.ReactNode }) {
  const { pending } = useFormStatus();
  return <>{children(pending)}</>;
}

function Feedback({ state }: { state: BookingActionState }) {
  if (state.error)
    return (
      <p className="text-[12px] font-semibold text-orange-tint-ink">
        {state.error}
      </p>
    );
  if (state.ok && state.message)
    return (
      <p className="text-[12px] font-semibold text-teal-tint-ink">
        {state.message}
      </p>
    );
  return null;
}

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  failed: "Payment failed",
  refunded: "Refunded",
};

export function BookingControls({
  id,
  status,
  docusignStatus,
  paymentStatus,
  refundKind,
  hasCharge,
  drivewayFeeApplied,
  drivewayFeeRate,
}: {
  id: string;
  status: BookingStatus;
  docusignStatus: DocusignStatus;
  paymentStatus: "unpaid" | "paid" | "failed" | "refunded";
  refundKind: "void" | "refund" | null;
  hasCharge: boolean;
  drivewayFeeApplied: boolean;
  drivewayFeeRate: number;
}) {
  const [statusState, statusAction] = useFormState(changeStatusAction, init);
  const [agrState, agrAction] = useFormState(setAgreementAction, init);
  const [refundState, refundFormAction] = useFormState(refundAction, init);
  const [applyFeeState, applyFeeAction] = useFormState(applyDrivewayFeeAction, init);
  const [removeFeeState, removeFeeAction] = useFormState(removeDrivewayFeeAction, init);

  const nexts = nextBookingStatuses(status);
  const canRefund = paymentStatus === "paid" && hasCharge;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Lifecycle
        </div>
        <div className="flex flex-wrap gap-2">
          {nexts.length === 0 && (
            <span className="text-[12px] text-ink-2">Terminal state.</span>
          )}
          {nexts.map((to) => (
            <form key={to} action={statusAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="to" value={to} />
              <Pending>
                {(p) => (
                  <button
                    disabled={p}
                    className={`px-3 py-2 text-[12px] font-extrabold disabled:opacity-60 ${
                      to === "cancelled"
                        ? "border-2 border-ink bg-transparent hover:bg-tint"
                        : "bg-teal text-white hover:bg-teal-700"
                    }`}
                  >
                    → {BOOKING_STATUS_META[to].label}
                  </button>
                )}
              </Pending>
            </form>
          ))}
        </div>
        <div className="mt-1.5">
          <Feedback state={statusState} />
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Rental agreement — currently {DOCUSIGN_META[docusignStatus]}
        </div>
        <div className="flex flex-wrap gap-2">
          {DOCUSIGN_STATUSES.filter((s) => s !== docusignStatus).map((to) => (
            <form key={to} action={agrAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="to" value={to} />
              <Pending>
                {(p) => (
                  <button
                    disabled={p}
                    className="border-2 border-line px-3 py-2 text-[12px] font-extrabold hover:border-ink disabled:opacity-60"
                  >
                    Mark {DOCUSIGN_META[to].toLowerCase()}
                  </button>
                )}
              </Pending>
            </form>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">
          Confirm against the DocuSign dashboard before marking signed. A Connect
          webhook will automate this later.
        </p>
        <Feedback state={agrState} />
      </div>

      <div>
        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Payment — {PAYMENT_LABEL[paymentStatus] ?? paymentStatus}
          {paymentStatus === "refunded" && refundKind
            ? ` (${refundKind === "void" ? "voided pre-settlement" : "refunded"})`
            : ""}
        </div>

        {canRefund ? (
          <div className="flex flex-wrap gap-2">
            <form
              action={refundFormAction}
              onSubmit={(e) => {
                if (
                  !confirm(
                    "Refund this payment in QuickBooks? QuickBooks will void it if it hasn't settled yet, otherwise issue a refund.",
                  )
                )
                  e.preventDefault();
              }}
            >
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="cancel" value="0" />
              <Pending>
                {(p) => (
                  <button
                    disabled={p}
                    className="border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
                  >
                    Refund payment
                  </button>
                )}
              </Pending>
            </form>
            {status !== "cancelled" && status !== "returned" && (
              <form
                action={refundFormAction}
                onSubmit={(e) => {
                  if (
                    !confirm(
                      "Refund the payment AND cancel this booking? This cancels open jobs and frees any assigned unit.",
                    )
                  )
                    e.preventDefault();
                }}
              >
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="cancel" value="1" />
                <Pending>
                  {(p) => (
                    <button
                      disabled={p}
                      className="bg-orange px-3 py-2 text-[12px] font-extrabold text-white hover:opacity-90 disabled:opacity-60"
                    >
                      Cancel &amp; refund
                    </button>
                  )}
                </Pending>
              </form>
            )}
          </div>
        ) : paymentStatus === "unpaid" ? (
          <p className="text-[12px] text-ink-2">
            No successful charge on this booking.
          </p>
        ) : null}

        <div className="mt-1.5">
          <Feedback state={refundState} />
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Driveway protection fee
        </div>
        {drivewayFeeApplied ? (
          <form
            action={removeFeeAction}
            onSubmit={(e) => {
              if (
                !confirm(
                  "Remove the driveway fee? This voids the separate QuickBooks invoice for it.",
                )
              )
                e.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={id} />
            <Pending>
              {(p) => (
                <button
                  disabled={p}
                  className="border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
                >
                  Remove &amp; void QuickBooks invoice
                </button>
              )}
            </Pending>
          </form>
        ) : drivewayFeeRate > 0 ? (
          <form action={applyFeeAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={id} />
            <input
              name="note"
              placeholder="Why (optional) — e.g. steep gravel drive"
              className="border-2 border-line bg-bg px-2.5 py-2 text-[13px] text-ink"
            />
            <Pending>
              {(p) => (
                <button
                  disabled={p}
                  className="self-start border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
                >
                  Apply ${drivewayFeeRate.toFixed(2)} fee
                </button>
              )}
            </Pending>
          </form>
        ) : (
          <p className="text-[12px] text-ink-2">
            Set a driveway protection fee rate in Settings first.
          </p>
        )}
        <p className="mt-1.5 text-[11px] text-ink-3">
          Not charged via card — billed as a separate QuickBooks invoice for
          the office to collect.
        </p>
        <div className="mt-1.5">
          <Feedback state={applyFeeState} />
          <Feedback state={removeFeeState} />
        </div>
      </div>
    </div>
  );
}
