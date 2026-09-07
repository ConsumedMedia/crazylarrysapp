import { notFound } from "next/navigation";
import { myJob, myJobs } from "@/lib/driver/queries";
import { DriverListPane, summarizeJobs } from "../_components/DriverListPane";
import { JobDetailContent } from "../_components/JobDetailContent";

export const dynamic = "force-dynamic";

export default async function DriverJobPage({
  params,
}: {
  params: { jobId: string };
}) {
  const job = await myJob(params.jobId);
  if (!job) notFound();

  const { jobs: dayJobs } = await myJobs(job.scheduled_date);
  const stopNumber = dayJobs.findIndex((j) => j.id === job.id) + 1;
  const stopTotal = dayJobs.length;
  const { nextJobId } = summarizeJobs(dayJobs);
  const yardPhone = process.env.CL_YARD_PHONE || null;

  return (
    <>
      {/* Phone: full-page detail, same as tapping through from the list. */}
      <div className="lg:hidden">
        <JobDetailContent
          job={job}
          stopNumber={stopNumber}
          stopTotal={stopTotal}
          yardPhone={yardPhone}
        />
      </div>

      {/* Tablet and up: the day's list stays visible on the left — tapping
          another job is a normal navigation to /driver/[id], not a
          client-side selection, so it works exactly like the phone route
          underneath, just laid out side-by-side. */}
      <div className="hidden lg:grid lg:grid-cols-[380px_1fr] lg:items-start lg:gap-5">
        <DriverListPane
          dateLabel="Today's stops"
          jobs={dayJobs}
          nextJobId={nextJobId}
          activeJobId={job.id}
        />
        <div className="border-2 border-line-strong bg-surface p-5">
          <JobDetailContent
            job={job}
            stopNumber={stopNumber}
            stopTotal={stopTotal}
            yardPhone={yardPhone}
            showBackHeader={false}
          />
        </div>
      </div>
    </>
  );
}
