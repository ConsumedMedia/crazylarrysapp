import { Skeleton } from "@/lib/design/Skeleton";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ScheduleLoading() {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
            Schedule
          </h1>
          <p className="text-[12px] text-ink-2">
            Deliveries, active rentals, and pickups across the fleet.
          </p>
        </div>
        <div className="flex gap-1.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[34px] w-16" />
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <div className="self-start border-2 border-line-strong bg-surface">
          <div className="border-b-2 border-line-strong px-4 py-3">
            <Skeleton className="h-[17px] w-32" />
          </div>
          <div className="grid grid-cols-7 gap-px bg-line p-px">
            {DAY_NAMES.map((d) => (
              <div
                key={d}
                className="bg-surface py-1.5 text-center text-[10px] font-extrabold uppercase tracking-[0.1em] text-ink-3"
              >
                {d}
              </div>
            ))}
            {Array.from({ length: 35 }).map((_, i) => (
              <div key={i} className="min-h-[84px] bg-surface p-1.5">
                <Skeleton className="h-[13px] w-5" />
              </div>
            ))}
          </div>
        </div>

        <section className="border-2 border-line-strong bg-surface">
          <div className="border-b-2 border-line-strong px-4 py-3">
            <Skeleton className="h-[15px] w-28" />
          </div>
          <div className="flex flex-col gap-2.5 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[40px] w-full" />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
