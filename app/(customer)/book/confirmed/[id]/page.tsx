import Link from "next/link";
import { notFound } from "next/navigation";
import { getBookingConfirmation } from "@/lib/bookings/queries";

export const dynamic = "force-dynamic";
export const metadata = { title: "You're booked · Crazy Larry's" };

function fmt(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function ConfirmedPage({
  params,
}: {
  params: { id: string };
}) {
  const booking = await getBookingConfirmation(params.id);
  if (!booking) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:px-8">
      <div className="mb-6 flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center bg-pink text-[13px] font-black text-white">
          CL
        </div>
        <span className="text-[11px] font-extrabold uppercase tracking-[0.12em]">
          Crazy Larry&apos;s
        </span>
      </div>

      <h1 className="text-[36px] font-black leading-[1.03] tracking-[-0.035em]">
        You&apos;re booked for {fmt(booking.delivery_date)}.
      </h1>
      <p className="mt-3 text-[15px] text-ink-2">
        A text and emailed receipt are on the way. The driver texts a two-hour
        delivery window the night before.
      </p>

      <div className="mt-6 border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
          What you booked
        </div>
        <dl className="grid gap-4 p-4 sm:grid-cols-2">
          <Item label="Size" value={booking.size.replace("yd", " yard")} />
          <Item label="Status" value={booking.status} />
          <Item label="Drop-off" value={fmt(booking.delivery_date)} />
          {booking.pickup_date && (
            <Item label="Pickup" value={fmt(booking.pickup_date)} />
          )}
          <Item label="Address" value={booking.delivery_address} />
          <Item
            label="Total"
            value={`$${booking.total.toFixed(2)} (incl. $${booking.tax.toFixed(2)} tax)`}
          />
        </dl>
      </div>

      <Link
        href="/book"
        className="mt-6 inline-block border-2 border-ink px-4 py-2.5 text-[13px] font-extrabold hover:bg-tint"
      >
        Book another
      </Link>
    </main>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        {label}
      </div>
      <div className="text-[15px] font-extrabold">{value}</div>
    </div>
  );
}
