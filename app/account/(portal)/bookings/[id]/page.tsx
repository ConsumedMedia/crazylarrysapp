import Link from "next/link";
import { notFound } from "next/navigation";
import { getMyBookingDetail } from "@/lib/customers/portal";
import { listChangeRequestsForBooking } from "@/lib/bookings/change-requests";
import { getPricingConfig } from "@/lib/bookings/pricing";
import { BOOKING_STATUS_META, DOCUSIGN_META } from "@/lib/bookings/state-machine";
import { BRAND_BADGE_CLASS } from "@/lib/design/tokens";
import { RequestChangeForm } from "./_components/RequestChangeForm";

export const dynamic = "force-dynamic";

const CLOSED_STATUSES = new Set(["returned", "cancelled"]);

function fmt(d: string | null) {
  if (!d) return "—";
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  failed: "Payment failed",
  refunded: "Refunded",
};

export default async function AccountBookingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const booking = await getMyBookingDetail(params.id);
  if (!booking) notFound();

  const [requests, pricing] = await Promise.all([
    listChangeRequestsForBooking(booking.id),
    getPricingConfig(),
  ]);
  const closed = CLOSED_STATUSES.has(booking.status);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/account"
        className="text-[12px] font-extrabold text-ink-2 hover:text-ink"
      >
        ← My bookings
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[21px] font-extrabold tracking-[-0.02em] md:text-[26px]">
          {booking.size_requested.replace("yd", " yard")} dumpster
        </h1>
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${BRAND_BADGE_CLASS[BOOKING_STATUS_META[booking.status].brand]}`}
        >
          {BOOKING_STATUS_META[booking.status].label}
        </span>
      </div>

      <section className="border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
          Booking
        </div>
        <dl className="grid gap-4 p-4 sm:grid-cols-2">
          <Item label="Delivery" value={fmt(booking.delivery_date)} />
          <Item label="Pickup" value={fmt(booking.pickup_date)} />
          <Item label="Address" value={booking.delivery_address} />
          <Item label="Debris" value={booking.debris_type ?? "—"} />
          <Item label="Placement notes" value={booking.placement_notes ?? "—"} />
          <Item label="Agreement" value={DOCUSIGN_META[booking.docusign_status]} />
          <Item
            label="Total"
            value={`$${booking.total.toFixed(2)} (sub $${booking.subtotal.toFixed(2)} + tax $${booking.tax.toFixed(2)})`}
          />
          <Item label="Payment" value={PAYMENT_LABEL[booking.payment_status] ?? booking.payment_status} />
        </dl>
      </section>

      <RequestChangeForm
        bookingId={booking.id}
        size={booking.size_requested}
        currentDeliveryDate={booking.delivery_date}
        currentPickupDate={booking.pickup_date ?? booking.delivery_date}
        extraDayRate={pricing.settings.extra_day_rate}
        canRequest={!closed}
        closedReason={
          closed ? "This booking is closed out — no changes can be requested." : null
        }
        requests={requests}
      />
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        {label}
      </div>
      <div className="text-[14px] font-bold">{value}</div>
    </div>
  );
}
