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
  devPayAction,
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

export function BookingControls({
  id,
  status,
  docusignStatus,
  devStubs,
  paid,
}: {
  id: string;
  status: BookingStatus;
  docusignStatus: DocusignStatus;
  devStubs: boolean;
  paid: boolean;
}) {
  const [statusState, statusAction] = useFormState(changeStatusAction, init);
  const [agrState, agrAction] = useFormState(setAgreementAction, init);
  const [payState, payAction] = useFormState(devPayAction, init);

  const nexts = nextBookingStatuses(status);

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
          Payment
        </div>
        {paid ? (
          <p className="text-[12px] font-semibold text-teal-tint-ink">
            Marked paid (dev stub — no real charge).
          </p>
        ) : devStubs ? (
          <form action={payAction}>
            <input type="hidden" name="id" value={id} />
            <Pending>
              {(p) => (
                <button
                  disabled={p}
                  className="border-2 border-dashed border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
                >
                  Dev: simulate successful payment
                </button>
              )}
            </Pending>
          </form>
        ) : (
          <p className="text-[12px] text-ink-2">
            QuickBooks Payments — Phase 5. (Dev stub disabled.)
          </p>
        )}
        <Feedback state={payState} />
      </div>
    </div>
  );
}
