import Link from "next/link";
import { myJobs } from "@/lib/driver/queries";

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

  const open = jobs.filter((j) => j.status !== "completed");
  const done = jobs.filter((j) => j.status === "completed");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[22px] font-black leading-tight tracking-[-0.02em]">
          {fmtDate(day)}
        </h1>
        <p className="text-[13px] text-ink-2">
          {open.length} to do{done.length > 0 && ` · ${done.length} done`}
        </p>
      </div>

      {jobs.length === 0 && (
        <p className="border-2 border-line bg-surface p-4 text-[14px] text-ink-2">
          Nothing scheduled for you today.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {open.map((j) => (
          <li key={j.id}>
            <Link
              href={`/driver/${j.id}`}
              className="flex flex-col gap-1.5 border-2 border-line-strong bg-surface p-4 active:bg-tint"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${
                    j.type === "delivery"
                      ? "bg-teal-tint text-teal-tint-ink"
                      : "bg-purple-tint text-purple-tint-ink"
                  }`}
                >
                  {j.type}
                </span>
                <span className="cl-nums text-[13px] font-bold">
                  {j.size_requested.replace("yd", " yd")}
                </span>
                {j.dumpster_unit && (
                  <span className="cl-nums text-[13px] text-ink-2">
                    {j.dumpster_unit}
                  </span>
                )}
                {j.route_order && (
                  <span className="ml-auto cl-nums text-[13px] font-extrabold text-ink-3">
                    #{j.route_order}
                  </span>
                )}
              </div>
              <div className="text-[16px] font-bold leading-tight">
                {j.delivery_address}
              </div>
              <div className="text-[13px] text-ink-2">{j.customer_name}</div>
            </Link>
          </li>
        ))}
      </ul>

      {done.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
            Done
          </div>
          {done.map((j) => (
            <div
              key={j.id}
              className="flex items-center gap-2 border-2 border-line bg-surface-2 p-3 text-[13px] text-ink-2"
            >
              <span className="px-1.5 py-0.5 text-[10px] font-extrabold uppercase bg-tint">
                {j.type}
              </span>
              <span className="truncate">{j.delivery_address}</span>
              <span className="ml-auto text-teal-tint-ink">✓</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
