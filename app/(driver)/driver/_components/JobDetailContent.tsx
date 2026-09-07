import Link from "next/link";
import type { DispatchJob } from "@/lib/dispatch/types";
import { CompleteButton } from "./CompleteButton";

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The full job-detail view — everything below the "Stop X of Y" header.
 * Shared by the phone full-page route (app/(driver)/driver/[jobId]/page.tsx)
 * and the tablet-and-up right-hand pane in both /driver and /driver/[jobId]
 * (see DriverListPane) — one piece of markup, two placements.
 */
export function JobDetailContent({
  job,
  stopNumber,
  stopTotal,
  yardPhone,
  showBackHeader = true,
}: {
  job: DispatchJob;
  stopNumber: number;
  stopTotal: number;
  yardPhone: string | null;
  /** Phone context wants the back arrow + "Stop X of Y" line; the tablet
   *  rail already shows the full list alongside, so it's redundant there. */
  showBackHeader?: boolean;
}) {
  const isToday = job.scheduled_date === todayYmd();
  const mapsHref = `https://maps.google.com/?q=${encodeURIComponent(job.delivery_address)}`;

  return (
    <div className="flex flex-col gap-4">
      {showBackHeader && (
        <div className="flex items-center gap-2.5">
          <Link
            href="/driver"
            aria-label="Back to my day"
            className="cl-btn grid h-11 w-11 flex-none place-items-center border-2 border-ink text-ink"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
          {stopNumber > 0 && (
            <span className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-ink-3">
              Stop {stopNumber} of {stopTotal} · {isToday ? "today" : fmtDate(job.scheduled_date)}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${
            job.type === "delivery"
              ? "bg-teal-tint text-teal-tint-ink"
              : "bg-purple-tint text-purple-tint-ink"
          }`}
        >
          {job.type}
        </span>
        <span className="cl-nums text-[14px] font-bold">
          {job.size_requested.replace("yd", " yd")}
        </span>
        {job.dumpster_unit && (
          <span className="cl-nums text-[14px] text-ink-2">
            unit {job.dumpster_unit}
          </span>
        )}
        <span
          className={`ml-auto px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${
            job.status === "completed"
              ? "bg-teal-tint text-teal-tint-ink"
              : "bg-tint text-ink-2"
          }`}
        >
          {job.status}
        </span>
      </div>

      <a
        href={mapsHref}
        target="_blank"
        rel="noopener noreferrer"
        className="cl-btn border-2 border-line-strong bg-surface p-4"
      >
        <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Address · tap for directions
        </div>
        <div className="mt-1 text-[18px] font-bold leading-tight">
          {job.delivery_address}
        </div>
        <div className="mt-1 cl-nums text-[13px] text-ink-2">
          {fmtDate(job.scheduled_date)}
        </div>
      </a>

      <div className="border-2 border-line-strong bg-surface p-4">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
          Customer
        </div>
        <div className="mt-1 text-[16px] font-bold">
          {job.customer_name}
          {job.customer_company && (
            <span className="text-ink-2"> · {job.customer_company}</span>
          )}
        </div>
        {job.customer_phone && (
          <a
            href={`tel:${job.customer_phone}`}
            className="mt-1 inline-block cl-nums text-[15px] font-bold text-teal-tint-ink underline"
          >
            {job.customer_phone}
          </a>
        )}
      </div>

      {job.debris_type && (
        <div className="border-2 border-line-strong bg-surface p-4">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Debris
          </div>
          <div className="mt-1 text-[14px] leading-snug">{job.debris_type}</div>
        </div>
      )}

      {job.placement_notes && (
        <div className="border-2 border-orange bg-orange-tint p-4">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-orange-tint-ink">
            Driver notes
          </div>
          <div className="mt-1 text-[14px] leading-snug text-orange-tint-ink">
            {job.placement_notes}
          </div>
        </div>
      )}

      {job.status === "completed" && job.has_photo && (
        <p className="text-[12px] text-ink-3">📷 Placement photo on file.</p>
      )}

      {job.status === "assigned" ? (
        <>
          <CompleteButton jobId={job.id} jobType={job.type} />
          {yardPhone && (
            <div className="flex flex-wrap gap-2">
              <a
                href={`tel:${yardPhone}`}
                className="cl-btn flex-1 border-2 border-ink px-3 py-3 text-center text-[13px] font-extrabold hover:bg-tint"
              >
                Can&apos;t complete
              </a>
              <a
                href={`sms:${yardPhone}`}
                className="cl-btn flex-1 border-2 border-ink px-3 py-3 text-center text-[13px] font-extrabold hover:bg-tint"
              >
                Message the office
              </a>
            </div>
          )}
        </>
      ) : (
        <p className="border-2 border-line bg-surface-2 p-4 text-center text-[14px] text-ink-2">
          {job.status === "completed"
            ? "Completed."
            : `This job is ${job.status}.`}
        </p>
      )}
    </div>
  );
}
