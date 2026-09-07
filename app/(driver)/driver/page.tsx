import { myJobs } from "@/lib/driver/queries";
import { DriverListPane, summarizeJobs } from "./_components/DriverListPane";
import { JobDetailContent } from "./_components/JobDetailContent";

export const dynamic = "force-dynamic";
export const metadata = { title: "My day · Crazy Larry's" };

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function DriverDayPage({
  searchParams,
}: {
  searchParams: { date?: string };
}) {
  const date =
    searchParams.date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date)
      ? searchParams.date
      : undefined;
  const { date: day, jobs } = await myJobs(date);
  const { nextJobId } = summarizeJobs(jobs);
  const nextJob = jobs.find((j) => j.id === nextJobId);
  const nextJobStopNumber = nextJob ? jobs.findIndex((j) => j.id === nextJob.id) + 1 : 0;
  const yardPhone = process.env.CL_YARD_PHONE || null;

  return (
    <div className="cl-fade-in">
      {/* Phone: the list is the whole page. */}
      <div className="lg:hidden">
        <DriverListPane dateLabel={fmtDate(day)} jobs={jobs} nextJobId={nextJobId} />
      </div>

      {/* Tablet and up: list rail + a detail pane defaulting to the next
          open job, so a driver glancing at a mounted screen sees what's
          next without tapping anything first. */}
      <div className="hidden lg:grid lg:grid-cols-[380px_1fr] lg:items-start lg:gap-5">
        <DriverListPane
          dateLabel={fmtDate(day)}
          jobs={jobs}
          nextJobId={nextJobId}
          activeJobId={nextJobId}
        />
        <div className="border-2 border-line-strong bg-surface p-5">
          {nextJob ? (
            <JobDetailContent
              job={nextJob}
              stopNumber={nextJobStopNumber}
              stopTotal={jobs.length}
              yardPhone={yardPhone}
              showBackHeader={false}
            />
          ) : (
            <p className="text-[14px] text-ink-2">
              {jobs.length === 0
                ? "Nothing scheduled for you today."
                : "All done for today — nice work."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
