import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import {
  listUnassignedJobs,
  listDrivers,
  listAvailableUnits,
  listDriverJobs,
  checkMatrix,
} from "@/lib/dispatch/queries";
import {
  JobCard,
  AssignmentPanel,
  DriverLane,
} from "./_components/DispatchClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dispatch · Crazy Larry's" };

type SP = { sel?: string; driver?: string; date?: string };

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

export default async function DispatchPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  await requireStaff();

  const [jobs, drivers] = await Promise.all([
    listUnassignedJobs(),
    listDrivers(),
  ]);
  const activeDrivers = drivers.filter((d) => d.active);

  const selected = searchParams.sel
    ? jobs.find((j) => j.id === searchParams.sel)
    : undefined;

  const matrix = selected
    ? await checkMatrix([selected.id], activeDrivers.map((d) => d.id))
    : {};

  const units =
    selected && selected.type === "delivery" && !selected.dumpster_id
      ? await listAvailableUnits(selected.size_requested)
      : [];

  const laneDriverId = searchParams.driver ?? activeDrivers[0]?.id ?? null;
  const laneDate =
    searchParams.date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date)
      ? searchParams.date
      : todayYmd();
  const laneJobs = laneDriverId
    ? await listDriverJobs(laneDriverId, laneDate)
    : [];

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Dispatch
        </h1>
        <p className="text-[12px] text-ink-2">
          {jobs.length} unassigned job{jobs.length === 1 ? "" : "s"} ·{" "}
          <Link href="/drivers" className="underline">
            Drivers →
          </Link>{" "}
          ·{" "}
          <Link href="/schedule" className="underline">
            Schedule →
          </Link>
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        {/* Unassigned queue */}
        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-extrabold uppercase tracking-[0.12em]">
            Needs a driver
          </div>
          {jobs.length === 0 && (
            <p className="border-2 border-line bg-surface p-4 text-[13px] text-ink-2">
              Nothing waiting. New bookings land here as delivery jobs; pickups
              appear when a rental is scheduled for pickup.
            </p>
          )}
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} selected={j.id === selected?.id} />
          ))}
        </div>

        {/* Right column: assignment panel + driver lane */}
        <div className="flex flex-col gap-4">
          {selected && (
            <AssignmentPanel
              job={selected}
              drivers={activeDrivers}
              checks={matrix[selected.id] ?? {}}
              units={units}
            />
          )}

          <section className="border-2 border-line-strong bg-surface">
            <div className="flex flex-wrap items-center gap-2 border-b-2 border-line-strong px-4 py-3">
              <span className="text-[13px] font-extrabold uppercase tracking-[0.12em]">
                Driver day
              </span>
              <form className="ml-auto flex items-center gap-2">
                <select
                  name="driver"
                  defaultValue={laneDriverId ?? ""}
                  className="border-2 border-line bg-bg px-2 py-1 text-[12px]"
                >
                  {activeDrivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.full_name}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  name="date"
                  defaultValue={laneDate}
                  className="border-2 border-line bg-bg px-2 py-1 text-[12px]"
                />
                {searchParams.sel && (
                  <input type="hidden" name="sel" value={searchParams.sel} />
                )}
                <button className="border-2 border-ink px-2 py-1 text-[11px] font-extrabold hover:bg-tint">
                  Go
                </button>
              </form>
            </div>
            <div className="p-4">
              {laneDriverId ? (
                <DriverLane
                  driverId={laneDriverId}
                  date={laneDate}
                  jobs={laneJobs}
                />
              ) : (
                <p className="text-[13px] text-ink-2">
                  No active drivers.{" "}
                  <Link href="/drivers" className="underline">
                    Add one
                  </Link>
                  .
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
