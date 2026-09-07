import { Skeleton } from "@/lib/design/Skeleton";

export default function BookingsLoading() {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Bookings
        </h1>
        <Skeleton className="mt-2 h-[13px] w-24" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[26px] w-16" />
        ))}
      </div>

      <div className="overflow-x-auto border-2 border-line-strong">
        <table className="w-full min-w-[640px] border-collapse bg-surface text-[13px]">
          <thead>
            <tr className="border-b-2 border-line-strong text-left text-[10px] font-extrabold uppercase tracking-[0.1em] text-ink-3">
              <th className="px-3 py-2.5">Customer</th>
              <th className="px-3 py-2.5">Size</th>
              <th className="px-3 py-2.5">Delivery</th>
              <th className="px-3 py-2.5">Pickup</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="border-b border-line last:border-b-0">
                <td className="px-3 py-3">
                  <Skeleton className="h-[13px] w-28" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-[13px] w-12" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-[13px] w-20" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-[13px] w-20" />
                </td>
                <td className="px-3 py-3">
                  <Skeleton className="h-[18px] w-20" />
                </td>
                <td className="px-3 py-3 text-right">
                  <Skeleton className="ml-auto h-[13px] w-14" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
