"use client";

import { useFormState, useFormStatus } from "react-dom";
import { STATUS_META, type DumpsterStatus } from "@/lib/dumpsters/state-machine";
import {
  changeStatusAction,
  saveNotesAction,
  type ActionState,
} from "../actions";

const initial: ActionState = { ok: false };

function Pending({ children }: { children: (p: boolean) => React.ReactNode }) {
  const { pending } = useFormStatus();
  return <>{children(pending)}</>;
}

function Feedback({ state }: { state: ActionState }) {
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

export function CanActions({
  id,
  nextStatuses,
  notes,
}: {
  id: string;
  nextStatuses: DumpsterStatus[];
  notes: string | null;
}) {
  const [statusState, statusFormAction] = useFormState(
    changeStatusAction,
    initial,
  );
  const [notesState, notesFormAction] = useFormState(saveNotesAction, initial);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Change status
        </div>
        <div className="flex flex-wrap gap-2">
          {nextStatuses.length === 0 && (
            <span className="text-[12px] text-ink-2">
              No transitions available.
            </span>
          )}
          {nextStatuses.map((to) => (
            <form key={to} action={statusFormAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="to" value={to} />
              <Pending>
                {(pending) => (
                  <button
                    type="submit"
                    disabled={pending}
                    className={`px-3 py-2 text-left text-[12px] font-extrabold disabled:opacity-60 ${
                      to === "out_of_service"
                        ? "border-2 border-ink bg-transparent text-ink hover:bg-tint"
                        : "border-0 bg-teal text-white hover:bg-teal-700"
                    }`}
                  >
                    → {STATUS_META[to].label}
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

      <form action={notesFormAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={id} />
        <label className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Condition notes
        </label>
        <textarea
          name="notes"
          defaultValue={notes ?? ""}
          rows={3}
          placeholder="Dents, mechanical issues, repaint history…"
          className="border-2 border-line bg-bg px-3 py-2 text-[13px] text-ink"
        />
        <div className="flex items-center gap-3">
          <Pending>
            {(pending) => (
              <button
                type="submit"
                disabled={pending}
                className="border-2 border-ink bg-transparent px-3 py-2 text-left text-[12px] font-extrabold text-ink hover:bg-tint disabled:opacity-60"
              >
                Save notes
              </button>
            )}
          </Pending>
          <Feedback state={notesState} />
        </div>
      </form>
    </div>
  );
}
