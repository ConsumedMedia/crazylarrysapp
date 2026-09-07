import { myRecentCompleted } from "@/lib/driver/queries";
import { JobRow } from "../_components/JobRow";

export const dynamic = "force-dynamic";
export const metadata = { title: "Done · Crazy Larry's" };

function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function DriverDonePage() {
  const jobs = await myRecentCompleted(7);

  const byDate = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const list = byDate.get(j.scheduled_date) ?? [];
    list.push(j);
    byDate.set(j.scheduled_date, list);
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[22px] font-black leading-tight tracking-[-0.02em]">
        Done this week
      </h1>

      {jobs.length === 0 && (
        <p className="border-2 border-line bg-surface p-4 text-[14px] text-ink-2">
          Nothing completed in the last 7 days.
        </p>
      )}

      {Array.from(byDate.entries()).map(([date, dayJobs]) => (
        <div key={date} className="flex flex-col gap-2">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            {fmtDate(date)}
          </div>
          {dayJobs.map((j, i) => (
            <JobRow key={j.id} job={j} stopNumber={i + 1} isNext={false} />
          ))}
        </div>
      ))}
    </div>
  );
}
