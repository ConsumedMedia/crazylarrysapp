"use client";

import { useEffect, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { DUMPSTER_SIZES } from "@/lib/dumpsters/state-machine";
import { addCanAction, type ActionState } from "../actions";

const initial: ActionState = { ok: false };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-teal px-3.5 py-2.5 text-left text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add can"}
    </button>
  );
}

export function AddCan() {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(addCanAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setOpen(false);
    }
  }, [state.ok, state.message]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="border-0 bg-teal px-3.5 py-2.5 text-left text-[12px] font-extrabold text-white hover:bg-teal-700"
      >
        + Add a can
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-wrap items-end gap-2 border-2 border-line-strong bg-surface p-3"
    >
      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Unit number
        <input
          name="unit_number"
          required
          placeholder="20-45"
          className="cl-nums w-28 border-2 border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Size
        <select
          name="size"
          className="border-2 border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
          defaultValue="10yd"
        >
          {DUMPSTER_SIZES.map((s) => (
            <option key={s} value={s}>
              {s.replace("yd", " yd")}
            </option>
          ))}
        </select>
      </label>
      <Submit />
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="border-2 border-line px-3 py-2 text-[12px] font-extrabold text-ink-2 hover:border-ink hover:text-ink"
      >
        Cancel
      </button>
      {state.error && (
        <p className="w-full text-[12px] font-semibold text-orange-tint-ink">
          {state.error}
        </p>
      )}
    </form>
  );
}
