import { myJobs } from "@/lib/driver/queries";
import { JobRow } from "./_components/JobRow";

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

  const doneCount = jobs.filter((j) => j.status === "completed").length;
  const toGoCount = jobs.length - doneCount;
  const nextJobId = jobs.find((j) => j.status !== "completed")?.id;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-black leading-tight tracking-[-0.02em]">
          {fmtDate(day)}
        </h1>
      </div>

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
          <JobRow key={j.id} job={j} stopNumber={i + 1} isNext={j.id === nextJobId} />
        ))}
      </div>
    </div>
  );
}
