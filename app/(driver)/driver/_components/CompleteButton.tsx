"use client";

import { useFormState, useFormStatus } from "react-dom";
import { completeJobAction, type CompleteState } from "../actions";

const init: CompleteState = { ok: false };

function Btn({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full bg-teal px-4 py-4 text-center text-[16px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "Marking…" : label}
    </button>
  );
}

export function CompleteButton({
  jobId,
  jobType,
}: {
  jobId: string;
  jobType: "delivery" | "pickup";
}) {
  const [state, action] = useFormState(completeJobAction, init);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="job_id" value={jobId} />
      <Btn label={jobType === "delivery" ? "Mark delivered" : "Mark picked up"} />
      {state.error && (
        <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink">
          {state.error}
        </p>
      )}
    </form>
  );
}
