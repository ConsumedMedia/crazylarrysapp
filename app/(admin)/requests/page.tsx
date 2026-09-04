import Link from "next/link";
import { listPendingChangeRequests } from "@/lib/bookings/change-requests";
import { ResolveRequestForm } from "./_components/ResolveRequestForm";

export const dynamic = "force-dynamic";

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function RequestsPage() {
  const requests = await listPendingChangeRequests();

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <h1 className="text-[21px] font-extrabold tracking-[-0.02em] md:text-[26px]">
        Change requests
      </h1>

      {requests.length === 0 ? (
        <div className="border-2 border-line-strong bg-surface p-6 text-center text-[13px] text-ink-2">
          No pending requests.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((r) => (
            <li key={r.id} className="border-2 border-line-strong bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  href={`/bookings/${r.booking_id}`}
                  className="text-[14px] font-extrabold hover:underline"
                >
                  {r.customer_name} — {r.booking_address}
                </Link>
                <span className="text-[11px] text-ink-3">
                  Requested {new Date(r.created_at).toLocaleDateString()}
                </span>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-[1fr_1fr]">
                <div className="text-[13px]">
                  <div className="text-ink-2">
                    Current: delivery {fmt(r.booking_delivery_date)}
                    {r.booking_pickup_date ? `, pickup ${fmt(r.booking_pickup_date)}` : ""}
                  </div>
                  {r.requested_delivery_date && (
                    <div className="font-bold">
                      New delivery: {fmt(r.requested_delivery_date)}
                    </div>
                  )}
                  {r.requested_pickup_date && (
                    <div className="font-bold">
                      New pickup: {fmt(r.requested_pickup_date)}
                    </div>
                  )}
                  <div className="mt-1 text-ink-2">&ldquo;{r.reason}&rdquo;</div>
                </div>
                <ResolveRequestForm id={r.id} bookingId={r.booking_id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
