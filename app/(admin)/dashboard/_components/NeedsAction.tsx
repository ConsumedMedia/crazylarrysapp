import type { OverdueRow, UnassignedRow } from "@/lib/dashboard/queries";

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function NeedsAction({
  overdueBookings,
  unassignedJobs,
}: {
  overdueBookings: OverdueRow[];
  unassignedJobs: UnassignedRow[];
}) {
  const empty = overdueBookings.length === 0 && unassignedJobs.length === 0;

  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-3">
        <h2 className="text-[15px] font-extrabold">Needs action</h2>
      </div>

      {empty ? (
        <p className="p-6 text-center text-[13px] text-ink-2">
          Nothing needs attention right now.
        </p>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          {overdueBookings.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-orange">
                Overdue ({overdueBookings.length})
              </div>
              <ul className="flex flex-col gap-1.5">
                {overdueBookings.map((b) => (
                  <li key={b.bookingId}>
                    <a
                      href={`/bookings/${b.bookingId}`}
                      className="flex items-center justify-between gap-2 border-l-4 border-orange bg-orange-tint px-2.5 py-1.5 text-[12px] text-orange-tint-ink hover:opacity-90"
                    >
                      <span className="truncate">
                        {b.address} · {b.customerName}
                      </span>
                      <span className="cl-nums flex-none font-extrabold">
                        since {fmt(b.pickupDate)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unassignedJobs.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
                Unassigned jobs ({unassignedJobs.length})
              </div>
              <ul className="flex flex-col gap-1.5">
                {unassignedJobs.map((j) => (
                  <li key={j.jobId}>
                    <a
                      href={`/dispatch?sel=${j.jobId}`}
                      className="flex items-center justify-between gap-2 border-2 border-line px-2.5 py-1.5 text-[12px] hover:border-ink"
                    >
                      <span className="truncate">
                        <span className="font-extrabold capitalize">{j.type}</span>{" "}
                        {j.address} · {j.customerName}
                      </span>
                      <span className="cl-nums flex-none text-ink-2">{fmt(j.scheduledDate)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
