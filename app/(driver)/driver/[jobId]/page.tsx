import Link from "next/link";
import { notFound } from "next/navigation";
import { myJob } from "@/lib/driver/queries";
import { CompleteButton } from "../_components/CompleteButton";

export const dynamic = "force-dynamic";

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function DriverJobPage({
  params,
}: {
  params: { jobId: string };
}) {
  const job = await myJob(params.jobId);
  if (!job) notFound();

  const mapsHref = `https://maps.google.com/?q=${encodeURIComponent(job.delivery_address)}`;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/driver" className="text-[13px] font-extrabold text-ink-2">
        ← My day
      </Link>

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
        className="border-2 border-line-strong bg-surface p-4"
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

      {job.status === "assigned" ? (
        <CompleteButton jobId={job.id} jobType={job.type} />
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
