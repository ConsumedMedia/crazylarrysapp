import type { OverdueRow, UnassignedRow } from "@/lib/dashboard/queries";
import type { FailedRefund } from "@/lib/payments/failed-refunds";
import { formatYardDateTime } from "@/lib/time/yard";
import { ResolveRefundButton } from "./ResolveRefundButton";

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
  failedRefunds = [],
}: {
  overdueBookings: OverdueRow[];
  unassignedJobs: UnassignedRow[];
  /** Compensating refunds that failed and nobody has resolved yet. */
  failedRefunds?: FailedRefund[];
}) {
  const empty = overdueBookings.length === 0 && unassignedJobs.length === 0 && failedRefunds.length === 0;

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
          {failedRefunds.length > 0 && (
            <div data-testid="failed-refunds">
              <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-orange">
                Refund failed — fix in QuickBooks ({failedRefunds.length})
              </div>
              <ul className="flex flex-col gap-1.5">
                {failedRefunds.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-1.5 border-l-4 border-orange bg-orange-tint px-2.5 py-2 text-[12px] text-orange-tint-ink"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-extrabold">
                        {r.amount !== null ? `$${r.amount.toFixed(2)}` : "Amount unknown"} charged, not refunded
                      </span>
                      <span className="cl-nums">{formatYardDateTime(r.createdAt)}</span>
                    </div>
                    <div>
                      {r.source === "pay_link" ? "Pay link" : "Online checkout"}
                      {r.chargeId && ` · charge ${r.chargeId}`}
                      {r.reason && ` · ${r.reason}`}
                      {r.bookingId && (
                        <>
                          {" · "}
                          <a href={`/bookings/${r.bookingId}`} className="font-bold underline">
                            booking
                          </a>
                        </>
                      )}
                    </div>
                    <ResolveRefundButton id={r.id} />
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                      className="cl-btn flex items-center justify-between gap-2 border-l-4 border-orange bg-orange-tint px-2.5 py-1.5 text-[12px] text-orange-tint-ink hover:opacity-90"
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
                      className="cl-btn flex items-center justify-between gap-2 border-2 border-line px-2.5 py-1.5 text-[12px] hover:border-ink"
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
