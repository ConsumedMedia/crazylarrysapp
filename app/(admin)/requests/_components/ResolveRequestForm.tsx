"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { resolveRequestAction, type RequestActionState } from "../actions";

const init: RequestActionState = { ok: false };

function Pending({ children }: { children: (p: boolean) => React.ReactNode }) {
  const { pending } = useFormStatus();
  return <>{children(pending)}</>;
}

export function ResolveRequestForm({ id, bookingId }: { id: string; bookingId: string }) {
  const [state, formAction] = useFormState(resolveRequestAction, init);
  const [note, setNote] = useState("");

  if (state.ok) {
    return <p className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bookingId" value={bookingId} />
      <textarea
        name="staffResponse"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note back to the customer"
        rows={2}
        className="border-2 border-line bg-bg px-3 py-2 text-[13px] font-medium text-ink"
      />
      <div className="flex gap-2">
        <Pending>
          {(p) => (
            <>
              <button
                name="decision"
                value="approved"
                disabled={p}
                className="bg-teal px-3 py-2 text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
              >
                Approve
              </button>
              <button
                name="decision"
                value="declined"
                disabled={p}
                className="border-2 border-ink px-3 py-2 text-[12px] font-extrabold hover:bg-tint disabled:opacity-60"
              >
                Decline
              </button>
            </>
          )}
        </Pending>
      </div>
      {state.error && (
        <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>
      )}
      <p className="text-[11px] text-ink-3">
        Approving here doesn&apos;t change the booking automatically — update the
        delivery/pickup date on the booking&apos;s own page after approving.
      </p>
    </form>
  );
}
