import { Skeleton } from "@/lib/design/Skeleton";

export default function FleetLoading() {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-end justify-between gap-3.5">
        <div>
          <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
            Fleet status board
          </h1>
          <p className="text-[12px] text-ink-2">
            Every can, every state, one screen
          </p>
        </div>
        <Skeleton className="h-[38px] w-32" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[26px] w-20" />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <div className="grid grid-cols-3 gap-0.5 self-start border-2 border-line-strong bg-line p-0.5 md:grid-cols-6">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="min-h-[96px] bg-surface p-2.5">
              <Skeleton className="h-full w-full" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4">
          <section className="border-2 border-line-strong bg-surface">
            <div className="border-b-2 border-line-strong px-4 py-3">
              <Skeleton className="h-[15px] w-32" />
            </div>
            <div className="flex flex-col items-center gap-4 px-4 py-5">
              <Skeleton className="h-[150px] w-[150px] rounded-full" />
            </div>
          </section>
          <section className="border-2 border-line-strong bg-surface">
            <div className="border-b-2 border-line-strong px-4 py-3">
              <Skeleton className="h-[15px] w-36" />
            </div>
            <div className="flex flex-col gap-3.5 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-[13px] w-24" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
