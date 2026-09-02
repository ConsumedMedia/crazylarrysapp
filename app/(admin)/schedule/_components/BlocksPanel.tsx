"use client";

import { useFormState, useFormStatus } from "react-dom";
import { DUMPSTER_SIZES } from "@/lib/dumpsters/state-machine";
import type { CalendarBlock } from "@/lib/availability/blocks";
import {
  createBlockAction,
  deleteBlockAction,
  type BlockActionState,
} from "../actions";

const initial: BlockActionState = { ok: false };

function fmt(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="border-0 bg-teal px-3 py-2 text-left text-[12px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "…" : label}
    </button>
  );
}

export function BlocksPanel({ blocks }: { blocks: CalendarBlock[] }) {
  const [createState, createForm] = useFormState(createBlockAction, initial);
  const [deleteState, deleteForm] = useFormState(deleteBlockAction, initial);

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-3 text-[15px] font-extrabold">
        Blocked dates
      </div>

      <form action={createForm} className="flex flex-col gap-2.5 border-b-2 border-line p-4">
        <div className="flex flex-wrap gap-2.5">
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Size
            <select
              name="size"
              defaultValue="all"
              className="border-2 border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
            >
              <option value="all">Fleet-wide</option>
              {DUMPSTER_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("yd", " yd")}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Start
            <input
              type="date"
              name="start_date"
              required
              className="border-2 border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            End
            <input
              type="date"
              name="end_date"
              required
              className="border-2 border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
            />
          </label>
        </div>
        <input
          name="reason"
          placeholder="Reason (e.g. yard closed — holiday)"
          className="border-2 border-line bg-bg px-2 py-1.5 text-[13px] text-ink"
        />
        <div className="flex items-center gap-3">
          <Submit label="Add block" />
          {createState.error && (
            <span className="text-[12px] font-semibold text-orange-tint-ink">
              {createState.error}
            </span>
          )}
          {createState.ok && createState.message && (
            <span className="text-[12px] font-semibold text-teal-tint-ink">
              {createState.message}
            </span>
          )}
        </div>
      </form>

      <ul className="flex flex-col">
        {blocks.length === 0 && (
          <li className="px-4 py-4 text-[13px] text-ink-2">
            No blocked dates.
          </li>
        )}
        {blocks.map((b) => (
          <li
            key={b.id}
            className="flex items-center gap-3 border-b border-line px-4 py-3 text-[13px] last:border-b-0"
          >
            <span className="cl-nums flex-none font-extrabold">
              {fmt(b.start_date)}
              {b.end_date !== b.start_date && ` – ${fmt(b.end_date)}`}
            </span>
            <span className="border-2 border-line px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-ink-2">
              {b.size ? b.size.replace("yd", " yd") : "Fleet-wide"}
            </span>
            <span className="flex-1 truncate text-ink-2">{b.reason ?? "—"}</span>
            <form action={deleteForm}>
              <input type="hidden" name="id" value={b.id} />
              <button
                type="submit"
                className="border-2 border-line px-2 py-1 text-[11px] font-extrabold text-ink-2 hover:border-orange hover:text-orange-tint-ink"
              >
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
      {deleteState.error && (
        <p className="px-4 py-2 text-[12px] font-semibold text-orange-tint-ink">
          {deleteState.error}
        </p>
      )}
    </section>
  );
}
