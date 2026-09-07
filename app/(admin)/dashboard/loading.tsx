import { Skeleton } from "@/lib/design/Skeleton";

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Overview
        </h1>
        <Skeleton className="mt-2 h-[14px] w-64 max-w-full" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 border-2 border-line-strong bg-surface p-4"
          >
            <Skeleton className="h-[10px] w-16" />
            <Skeleton className="h-[30px] w-10" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <section className="border-2 border-line-strong bg-surface">
          <div className="border-b-2 border-line-strong px-4 py-3">
            <Skeleton className="h-[15px] w-40" />
            <Skeleton className="mt-2 h-[11px] w-32" />
          </div>
          <ul className="flex flex-col">
            {Array.from({ length: 5 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <Skeleton className="h-[18px] w-14 flex-none" />
                <Skeleton className="h-[13px] w-10 flex-none" />
                <Skeleton className="h-[13px] flex-1" />
                <Skeleton className="h-[18px] w-20 flex-none" />
              </li>
            ))}
          </ul>
        </section>

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
              <Skeleton className="h-[15px] w-28" />
            </div>
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[38px] w-full" />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
