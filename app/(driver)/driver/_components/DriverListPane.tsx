import type { DispatchJob } from "@/lib/dispatch/types";
import { JobRow } from "./JobRow";

export function summarizeJobs(jobs: DispatchJob[]): {
  doneCount: number;
  toGoCount: number;
  nextJobId: string | undefined;
} {
  const doneCount = jobs.filter((j) => j.status === "completed").length;
  return {
    doneCount,
    toGoCount: jobs.length - doneCount,
    nextJobId: jobs.find((j) => j.status !== "completed")?.id,
  };
}

/**
 * Day heading + stat row + job list — the entire content of the phone's
 * /driver page, reused as the tablet-and-up left rail on both /driver and
 * /driver/[jobId] (see summarizeJobs for the shared done/to-go/next math).
 */
export function DriverListPane({
  dateLabel,
  jobs,
  nextJobId,
  activeJobId,
}: {
  dateLabel: string;
  jobs: DispatchJob[];
  nextJobId: string | undefined;
  /** The job currently shown in the right-hand pane, if any (tablet only). */
  activeJobId?: string;
}) {
  const { doneCount, toGoCount } = summarizeJobs(jobs);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-black leading-tight tracking-[-0.02em]">
        {dateLabel}
      </h1>

      {jobs.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="border-2 border-line-strong border-t-[5px] border-t-gray-st bg-surface p-3">
            <div className="cl-nums text-[24px] font-black leading-none">{doneCount}</div>
            <div className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.12em] text-ink-3">
              Done
            </div>
          </div>
          <div className="border-2 border-line-strong border-t-[5px] border-t-pink bg-surface p-3">
            <div className="cl-nums text-[24px] font-black leading-none">{toGoCount}</div>
            <div className="mt-1 text-[10px] font-extrabold uppercase tracking-[0.12em] text-ink-3">
              To go
            </div>
          </div>
        </div>
      )}

      {jobs.length === 0 && (
        <p className="border-2 border-line bg-surface p-4 text-[14px] text-ink-2">
          Nothing scheduled for you today.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {jobs.map((j, i) => (
          <JobRow
            key={j.id}
            job={j}
            stopNumber={i + 1}
            isNext={j.id === nextJobId}
            active={j.id === activeJobId}
          />
        ))}
      </div>
    </div>
  );
}
