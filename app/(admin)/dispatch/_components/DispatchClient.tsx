"use client";

import { useFormState, useFormStatus } from "react-dom";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { DispatchJob, DriverRow, AssignmentCheck } from "@/lib/dispatch/types";
import { KNOWN_JOB_TAGS, prettyTag } from "@/lib/dispatch/tags";
import {
  assignJobAction,
  unassignJobAction,
  reorderAction,
  confirmTagsAction,
  type DispatchActionState,
} from "../actions";

const init: DispatchActionState = { ok: false };

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`px-3 py-2 text-left text-[12px] font-extrabold disabled:opacity-60 ${
        danger
          ? "border-2 border-ink bg-transparent hover:bg-tint"
          : "border-0 bg-teal text-white hover:bg-teal-700"
      }`}
    >
      {pending ? "…" : label}
    </button>
  );
}

// ---------------------------------------------------------------------------

export function JobCard({
  job,
  selected,
}: {
  job: DispatchJob;
  selected: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const untagged = job.job_tags_confirmed_at === null;

  function toggle() {
    const next = new URLSearchParams(params.toString());
    if (selected) next.delete("sel");
    else next.set("sel", job.id);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  return (
    <button
      onClick={toggle}
      className={`flex w-full flex-col gap-1.5 border-2 p-3 text-left ${
        selected ? "border-ink bg-tint" : "border-line hover:border-ink"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
            job.type === "delivery"
              ? "bg-teal-tint text-teal-tint-ink"
              : "bg-purple-tint text-purple-tint-ink"
          }`}
        >
          {job.type}
        </span>
        <span className="cl-nums text-[12px] font-bold">
          {job.size_requested.replace("yd", " yd")}
        </span>
        <span className="cl-nums text-[12px] text-ink-2">
          {fmtDate(job.scheduled_date)}
        </span>
      </div>
      <div className="text-[13px] font-bold">{job.delivery_address}</div>
      <div className="text-[12px] text-ink-2">
        {job.customer_name}
        {job.customer_company && ` · ${job.customer_company}`}
        {job.debris_type && ` · ${job.debris_type}`}
      </div>
      <div className="flex flex-wrap gap-1">
        {job.job_tags.map((t) => (
          <span key={t} className="bg-tint px-1.5 py-0.5 text-[10px] font-bold">
            {prettyTag(t)}
          </span>
        ))}
        {untagged && (
          <span className="bg-orange-tint px-1.5 py-0.5 text-[10px] font-extrabold text-orange-tint-ink">
            untagged
          </span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------

export function AssignmentPanel({
  job,
  drivers,
  checks,
  units,
}: {
  job: DispatchJob;
  drivers: DriverRow[];
  checks: Record<string, AssignmentCheck | undefined>;
  units: Array<{ id: string; unit_number: string }>;
}) {
  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-3">
        <div className="text-[13px] font-extrabold uppercase tracking-[0.12em]">
          Assign — {job.type} · {job.delivery_address}
        </div>
        <div className="text-[12px] text-ink-2">
          {job.customer_name}
          {job.customer_company && ` · ${job.customer_company}`} ·{" "}
          {job.size_requested.replace("yd", " yd")}
        </div>
      </div>

      <div className="border-b border-line p-4">
        <TagConfirm job={job} />
      </div>

      <ul className="flex flex-col">
        {drivers.map((d) => (
          <li key={d.id} className="border-b border-line p-4 last:border-b-0">
            <DriverAssignRow job={job} driver={d} check={checks[d.id]} units={units} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DriverAssignRow({
  job,
  driver,
  check,
  units,
}: {
  job: DispatchJob;
  driver: DriverRow;
  check: AssignmentCheck | undefined;
  units: Array<{ id: string; unit_number: string }>;
}) {
  const [state, action] = useFormState(assignJobAction, init);

  const blocked = check && !check.allowed;
  const warn = check && check.allowed && check.requires_override;

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="job_id" value={job.id} />
      <input type="hidden" name="driver_id" value={driver.id} />
      <input type="hidden" name="override" value={(warn ? true : false).toString()} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-bold">{driver.full_name}</span>
        <span className="text-[12px] text-ink-2">
          {driver.truck_nickname ?? "no truck"}
        </span>
        {blocked && (
          <span className="bg-orange-tint px-1.5 py-0.5 text-[10px] font-extrabold text-orange-tint-ink">
            blocked
          </span>
        )}
        {warn && (
          <span className="bg-orange-tint px-1.5 py-0.5 text-[10px] font-extrabold text-orange-tint-ink shadow-[inset_0_0_0_2px_var(--cl-orange)]">
            needs override
          </span>
        )}
        {check && check.allowed && !warn && (
          <span className="bg-teal-tint px-1.5 py-0.5 text-[10px] font-extrabold text-teal-tint-ink">
            ok
          </span>
        )}
      </div>

      {blocked && check && (
        <ul className="text-[12px] text-orange-tint-ink">
          {check.blockers.map((b, i) => (
            <li key={i}>
              • {b.detail ?? `${b.dimension}: ${b.match_value}`}
              {b.source_phrase && ` — "${b.source_phrase}"`}
            </li>
          ))}
        </ul>
      )}
      {warn && check && (
        <ul className="text-[12px] text-orange-tint-ink">
          {check.warnings.map((w, i) => (
            <li key={i}>
              • {w.detail ?? `${w.dimension}: ${w.match_value}`}
              {w.source_phrase && ` — "${w.source_phrase}"`}
            </li>
          ))}
        </ul>
      )}

      {!blocked && (
        <div className="flex flex-wrap items-center gap-2">
          {job.type === "delivery" && !job.dumpster_id && (
            <select
              name="dumpster_id"
              required
              className="border-2 border-line bg-bg px-2 py-1.5 text-[12px]"
            >
              <option value="">Pick a unit…</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.unit_number}
                </option>
              ))}
            </select>
          )}
          {job.type === "delivery" && job.dumpster_id && (
            <span className="cl-nums text-[12px] text-ink-2">
              unit {job.dumpster_unit}
            </span>
          )}
          <Submit label={warn ? "Assign anyway" : "Assign"} />
        </div>
      )}

      {state.error && (
        <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>
      )}
      {state.ok && state.message && (
        <p className="text-[12px] font-semibold text-teal-tint-ink">{state.message}</p>
      )}
    </form>
  );
}

function TagConfirm({ job }: { job: DispatchJob }) {
  const [state, action] = useFormState(confirmTagsAction, init);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="booking_id" value={job.booking_id} />
      <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        Job tags {job.job_tags_confirmed_at ? "(confirmed)" : "(not reviewed)"}
      </div>
      <div className="flex flex-wrap gap-2">
        {KNOWN_JOB_TAGS.map((t) => (
          <label key={t} className="flex items-center gap-1.5 text-[12px] font-bold">
            <input
              type="checkbox"
              name="tags"
              value={t}
              defaultChecked={job.job_tags.includes(t)}
            />
            {prettyTag(t)}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Submit label="Confirm tags" />
        {state.ok && state.message && (
          <span className="text-[12px] font-semibold text-teal-tint-ink">
            {state.message}
          </span>
        )}
        {state.error && (
          <span className="text-[12px] font-semibold text-orange-tint-ink">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function DriverLane({
  driverId,
  date,
  jobs,
}: {
  driverId: string;
  date: string;
  jobs: DispatchJob[];
}) {
  const [state, action] = useFormState(reorderAction, init);
  const [unState, unAction] = useFormState(unassignJobAction, init);

  function move(idx: number, dir: -1 | 1) {
    const ids = jobs.map((j) => j.id);
    const t = idx + dir;
    if (t < 0 || t >= ids.length) return;
    [ids[idx], ids[t]] = [ids[t], ids[idx]];
    const fd = new FormData();
    fd.set("driver_id", driverId);
    fd.set("date", date);
    fd.set("job_ids", JSON.stringify(ids));
    action(fd);
  }

  return (
    <div className="flex flex-col gap-2">
      {jobs.length === 0 && (
        <p className="text-[13px] text-ink-2">No jobs assigned for this day.</p>
      )}
      {jobs.map((j, i) => (
        <div key={j.id} className="flex items-start gap-2 border-2 border-line p-3">
          <div className="flex flex-col">
            <button
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="text-[13px] font-extrabold disabled:opacity-30"
              aria-label="Move up"
            >
              ▲
            </button>
            <span className="cl-nums text-center text-[12px] font-extrabold">
              {j.route_order ?? i + 1}
            </span>
            <button
              onClick={() => move(i, 1)}
              disabled={i === jobs.length - 1}
              className="text-[13px] font-extrabold disabled:opacity-30"
              aria-label="Move down"
            >
              ▼
            </button>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={`px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
                  j.type === "delivery"
                    ? "bg-teal-tint text-teal-tint-ink"
                    : "bg-purple-tint text-purple-tint-ink"
                }`}
              >
                {j.type}
              </span>
              <span className="cl-nums text-[12px] font-bold">
                {j.size_requested.replace("yd", " yd")}
              </span>
              {j.dumpster_unit && (
                <span className="cl-nums text-[12px] text-ink-2">
                  {j.dumpster_unit}
                </span>
              )}
              <span
                className={`px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
                  j.status === "completed"
                    ? "bg-teal-tint text-teal-tint-ink"
                    : "bg-tint text-ink-2"
                }`}
              >
                {j.status}
              </span>
            </div>
            <div className="text-[13px] font-bold">{j.delivery_address}</div>
            <div className="text-[12px] text-ink-2">{j.customer_name}</div>
          </div>
          {j.status === "assigned" && (
            <form action={unAction}>
              <input type="hidden" name="job_id" value={j.id} />
              <button className="border-2 border-line px-2 py-1 text-[11px] font-extrabold hover:border-ink">
                Unassign
              </button>
            </form>
          )}
        </div>
      ))}
      {(state.error || unState.error) && (
        <p className="text-[12px] font-semibold text-orange-tint-ink">
          {state.error ?? unState.error}
        </p>
      )}
    </div>
  );
}
