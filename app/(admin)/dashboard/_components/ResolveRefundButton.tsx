"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { resolveRefundAction, type ResolveState } from "../actions";

const init: ResolveState = { ok: false };

function Confirm() {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={pending}
      className="bg-ink px-2 py-1 text-[11px] font-extrabold text-surface disabled:opacity-60"
    >
      {pending ? "…" : "Yes, mark resolved"}
    </button>
  );
}

/** Inline two-step confirm (no window.confirm). Pure apart from local state. */
export function ResolveRefundStep({
  id,
  stage,
  onAsk,
  onCancel,
  action,
}: {
  id: string;
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
        className="border-2 border-line px-2 py-1 text-[11px] font-extrabold hover:border-ink"
      >
        Mark resolved
      </button>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5" data-testid="resolve-confirm">
      <input type="hidden" name="id" value={id} />
      <span className="text-[11px] font-semibold">Refunded or settled in QuickBooks? This records you and the time.</span>
      <Confirm />
      <button type="button" onClick={onCancel} className="px-2 py-1 text-[11px] font-extrabold underline">
        Cancel
      </button>
    </form>
  );
}

export function ResolveRefundButton({ id }: { id: string }) {
  const [stage, setStage] = useState<"idle" | "confirm">("idle");
  const [state, action] = useFormState(resolveRefundAction, init);
  if (state.ok) return <span className="text-[11px] font-extrabold text-teal-tint-ink">Resolved</span>;
  return (
    <div className="flex flex-col gap-1">
      <ResolveRefundStep
        id={id}
        stage={stage}
        onAsk={() => setStage("confirm")}
        onCancel={() => setStage("idle")}
        action={action}
      />
      {state.error && <span className="text-[11px] font-semibold text-orange-tint-ink">{state.error}</span>}
    </div>
  );
}
