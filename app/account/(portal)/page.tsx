import Link from "next/link";
import { listMyBookings } from "@/lib/customers/portal";
import { listMyPendingChangeRequests } from "@/lib/bookings/change-requests";
import { BOOKING_STATUS_META } from "@/lib/bookings/state-machine";
import { BRAND_BADGE_CLASS } from "@/lib/design/tokens";
import { PendingRequestBanner } from "./_components/PendingRequestBanner";

export const dynamic = "force-dynamic";
export const metadata = { title: "My bookings · Crazy Larry's" };

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function AccountBookingsPage() {
  const [bookings, pendingRequests] = await Promise.all([
    listMyBookings(),
    listMyPendingChangeRequests(),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[21px] font-extrabold tracking-[-0.02em] md:text-[26px]">
          My bookings
        </h1>
        <Link
          href="/book"
          className="bg-teal px-3 py-2 text-[12px] font-extrabold text-white hover:bg-teal-700"
        >
          Book a dumpster
        </Link>
      </div>

      <PendingRequestBanner requests={pendingRequests} />

      {bookings.length === 0 ? (
        <div className="border-2 border-line-strong bg-surface p-6 text-center">
          <p className="text-[14px] font-bold">No bookings yet.</p>
          <p className="mt-1 text-[12px] text-ink-2">
            If you booked with us as a guest using this email, it&apos;ll show
            up here automatically.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {bookings.map((b) => (
            <li key={b.id}>
              <Link
                href={`/account/bookings/${b.id}`}
                className="flex flex-col gap-2 border-2 border-line-strong bg-surface p-4 hover:border-ink sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="text-[14px] font-extrabold">
                    {b.size_requested.replace("yd", " yard")} ·{" "}
                    {b.delivery_address}
                  </div>
                  <div className="text-[12px] text-ink-2">
                    Delivery {fmt(b.delivery_date)}
                    {b.pickup_date ? ` · Pickup ${fmt(b.pickup_date)}` : ""}
                  </div>
                </div>
                <span
                  className={`w-fit px-2 py-0.5 text-[11px] font-extrabold uppercase ${BRAND_BADGE_CLASS[BOOKING_STATUS_META[b.status].brand]}`}
                >
                  {BOOKING_STATUS_META[b.status].label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
