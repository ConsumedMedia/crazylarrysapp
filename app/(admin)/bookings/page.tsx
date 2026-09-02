import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listBookings } from "@/lib/bookings/queries";
import {
  BOOKING_STATUSES,
  BOOKING_STATUS_META,
  isBookingStatus,
} from "@/lib/bookings/state-machine";
import { BRAND_BADGE_CLASS } from "@/lib/design/tokens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bookings · Crazy Larry's" };

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  await requireStaff();
  const active = isBookingStatus(searchParams.status)
    ? searchParams.status
    : undefined;
  const bookings = await listBookings(active ? { status: active } : undefined);

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          Bookings
        </h1>
        <p className="text-[12px] text-ink-2">
          {bookings.length} {active ? `${active} ` : ""}booking
          {bookings.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Link
          href="/bookings"
          className={`border-2 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] ${
            !active ? "border-ink bg-ink text-surface" : "border-line hover:border-ink"
          }`}
        >
          All
        </Link>
        {BOOKING_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/bookings?status=${s}`}
            className={`border-2 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] ${
              active === s ? "border-ink text-ink" : "border-line hover:border-ink"
            }`}
          >
            {BOOKING_STATUS_META[s].label}
          </Link>
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
            {bookings.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-ink-2">
                  No bookings yet.
                </td>
              </tr>
            )}
            {bookings.map((b) => (
              <tr
                key={b.id}
                className="border-b border-line last:border-b-0 hover:bg-tint"
              >
                <td className="px-3 py-2.5">
                  <Link
                    href={`/bookings/${b.id}`}
                    className="font-bold underline-offset-2 hover:underline"
                  >
                    {b.customer_name}
                  </Link>
                </td>
                <td className="cl-nums px-3 py-2.5">
                  {b.size_requested.replace("yd", " yd")}
                </td>
                <td className="cl-nums px-3 py-2.5">{fmt(b.delivery_date)}</td>
                <td className="cl-nums px-3 py-2.5">{fmt(b.pickup_date)}</td>
                <td className="px-3 py-2.5">
                  <span
                    className={`px-1.5 py-0.5 text-[10px] font-extrabold uppercase ${BRAND_BADGE_CLASS[BOOKING_STATUS_META[b.status].brand]}`}
                  >
                    {BOOKING_STATUS_META[b.status].label}
                  </span>
                </td>
                <td className="cl-nums px-3 py-2.5 text-right font-bold">
                  ${b.total.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
