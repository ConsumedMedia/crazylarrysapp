import Link from "next/link";
import type { DispatchJob } from "@/lib/dispatch/types";

const COLOR = {
  done: { outer: "border-line", left: "border-l-gray-st", num: "bg-gray-st" },
  next: { outer: "border-teal", left: "border-l-teal", num: "bg-teal" },
  todo: { outer: "border-line-strong", left: "border-l-pink", num: "bg-pink" },
};

export function JobRow({
  job,
  stopNumber,
  isNext,
}: {
  job: DispatchJob;
  stopNumber: number;
  isNext: boolean;
}) {
  const done = job.status === "completed";
  const c = done ? COLOR.done : isNext ? COLOR.next : COLOR.todo;
  const mapsHref = `https://maps.google.com/?q=${encodeURIComponent(job.delivery_address)}`;

  return (
    <div
      className={`flex flex-col gap-2.5 border-2 border-l-8 ${c.outer} ${c.left} bg-surface p-3.5 ${done ? "opacity-55" : ""}`}
    >
      <div className="flex gap-3">
        <div
          className={`grid h-8 w-8 flex-none place-items-center text-[13px] font-extrabold text-white ${c.num}`}
        >
          {stopNumber}
        </div>
        <Link href={`/driver/${job.id}`} className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
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
            {job.dumpster_unit && (
              <span className="cl-nums text-[12px] text-ink-2">
                {job.dumpster_unit}
              </span>
            )}
          </div>
          <div className="mt-1 text-[15px] font-bold leading-tight">
            {job.delivery_address}
          </div>
          <div className="text-[13px] text-ink-2">{job.customer_name}</div>
          {job.placement_notes && (
            <div className="mt-1 truncate text-[12px] text-ink-3">
              {job.placement_notes}
            </div>
          )}
        </Link>
      </div>

      <div className="flex gap-2">
        <Link
          href={`/driver/${job.id}`}
          className={`flex flex-1 min-w-0 items-center justify-between px-3 py-3 text-[13px] font-extrabold ${
            done
              ? "bg-tint text-ink-2"
              : isNext
                ? "bg-teal text-white hover:bg-teal-700"
                : "bg-ink text-surface"
          }`}
        >
          {done ? "Completed" : isNext ? "Open this job" : "Open"}
          <span>{done ? "✓" : "→"}</span>
        </Link>
        {!done && (
          <>
            {job.customer_phone && (
              <a
                href={`tel:${job.customer_phone}`}
                aria-label="Call customer"
                className="grid w-12 flex-none place-items-center border-2 border-ink text-ink hover:bg-tint"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                >
                  <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />
                </svg>
              </a>
            )}
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Navigate"
              className="grid w-12 flex-none place-items-center border-2 border-ink text-ink hover:bg-tint"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              >
                <path d="M3 11 22 2l-9 19-2-8z" />
              </svg>
            </a>
          </>
        )}
      </div>
    </div>
  );
}
