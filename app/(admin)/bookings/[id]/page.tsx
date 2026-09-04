import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/requireStaff";
import { getBookingDetail } from "@/lib/bookings/queries";
import { listChangeRequestsForBooking } from "@/lib/bookings/change-requests";
import { BOOKING_STATUS_META, DOCUSIGN_META } from "@/lib/bookings/state-machine";
import { BRAND_BADGE_CLASS } from "@/lib/design/tokens";
import { BookingControls } from "./_components/BookingControls";
import { ResolveRequestForm } from "../../requests/_components/ResolveRequestForm";

export const dynamic = "force-dynamic";

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
function fmtTs(d: string) {
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function BookingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireStaff();
  const detail = await getBookingDetail(params.id);
  if (!detail) notFound();
  const { booking, customer, invoice, jobs, history } = detail;
  const changeRequests = await listChangeRequestsForBooking(booking.id);

  const paymentValue =
    booking.payment_status === "paid"
      ? `Paid${invoice?.qb_charge_id ? ` · charge ${invoice.qb_charge_id}` : ""}${
          invoice?.quickbooks_invoice_id
            ? ` · QBO inv ${invoice.quickbooks_invoice_id}`
            : invoice?.sync_status === "error"
              ? " · QBO sync failed (cron will retry)"
              : invoice
                ? " · QBO sync pending"
                : ""
        }`
      : booking.payment_status === "refunded"
        ? `Refunded${invoice?.refund_kind ? ` (${invoice.refund_kind})` : ""}${
            invoice?.qb_refund_id ? ` · ${invoice.qb_refund_id}` : ""
          }`
        : booking.payment_status === "failed"
          ? "Payment failed"
          : "Unpaid";

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <Link
        href="/bookings"
        className="text-[12px] font-extrabold text-ink-2 hover:text-ink"
      >
        ← All bookings
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[21px] font-extrabold tracking-[-0.02em] md:text-[26px]">
          {customer.full_name}
          {customer.company_name && (
            <span className="text-ink-2"> · {customer.company_name}</span>
          )}
        </h1>
        <span
          className={`px-2 py-0.5 text-[11px] font-extrabold uppercase ${BRAND_BADGE_CLASS[BOOKING_STATUS_META[booking.status].brand]}`}
        >
          {BOOKING_STATUS_META[booking.status].label}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-4">
          <section className="border-2 border-line-strong bg-surface">
            <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
              Booking
            </div>
            <dl className="grid gap-4 p-4 sm:grid-cols-2">
              <Item label="Size" value={booking.size_requested.replace("yd", " yard")} />
              <Item
                label="Unit assigned"
                value={booking.dumpster_id ? booking.dumpster_id : "Not yet (assigned at dispatch)"}
              />
              <Item label="Delivery" value={fmt(booking.delivery_date)} />
              <Item label="Pickup" value={fmt(booking.pickup_date)} />
              <Item label="Address" value={booking.delivery_address} />
              <Item label="Debris" value={booking.debris_type ?? "—"} />
              <Item label="Placement notes" value={booking.placement_notes ?? "—"} />
              <Item
                label="Agreement"
                value={DOCUSIGN_META[booking.docusign_status]}
              />
              <Item
                label="Total"
                value={`$${booking.total.toFixed(2)}  (sub $${booking.subtotal.toFixed(2)} + tax $${booking.tax.toFixed(2)})`}
              />
              <Item label="Payment" value={paymentValue} />
            </dl>
          </section>

          <section className="border-2 border-line-strong bg-surface">
            <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
              Contact
            </div>
            <dl className="grid gap-4 p-4 sm:grid-cols-3">
              <Item label="Name" value={customer.full_name} />
              <Item label="Phone" value={customer.phone ?? "—"} />
              <Item label="Email" value={customer.email ?? "—"} />
              <Item
                label="Account"
                value={customer.profile_id ? "Registered" : "Guest checkout"}
              />
            </dl>
          </section>

          {changeRequests.length > 0 && (
            <section className="border-2 border-line-strong bg-surface">
              <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
                Change requests
              </div>
              <ul className="flex flex-col">
                {changeRequests.map((r) => (
                  <li key={r.id} className="border-b border-line px-4 py-3 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="border-2 border-line px-1.5 py-0.5 text-[10px] font-extrabold uppercase">
                        {r.status}
                      </span>
                      <span className="text-[11px] text-ink-3">
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="mt-1 text-[13px]">
                      {r.requested_delivery_date && (
                        <div>New delivery: {fmt(r.requested_delivery_date)}</div>
                      )}
                      {r.requested_pickup_date && (
                        <div>New pickup: {fmt(r.requested_pickup_date)}</div>
                      )}
                      <div className="text-ink-2">&ldquo;{r.reason}&rdquo;</div>
                      {r.staff_response && (
                        <div className="mt-1 border-l-2 border-line pl-2 text-ink-2">
                          Staff: {r.staff_response}
                        </div>
                      )}
                    </div>
                    {r.status === "pending" && (
                      <div className="mt-2 max-w-sm">
                        <ResolveRequestForm id={r.id} bookingId={booking.id} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="border-2 border-line-strong bg-surface">
            <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
              Jobs
            </div>
            <ul className="flex flex-col">
              {jobs.length === 0 && (
                <li className="px-4 py-3 text-[13px] text-ink-2">No jobs.</li>
              )}
              {jobs.map((j) => (
                <li
                  key={j.id}
                  className="flex items-center gap-3 border-b border-line px-4 py-3 text-[13px] last:border-b-0"
                >
                  <span className="w-16 font-extrabold capitalize">{j.type}</span>
                  <span className="cl-nums text-ink-2">{fmt(j.scheduled_date)}</span>
                  <span className="ml-auto border-2 border-line px-1.5 py-0.5 text-[10px] font-extrabold uppercase">
                    {j.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="border-2 border-line-strong bg-surface">
            <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
              History
            </div>
            <ul className="flex flex-col p-4 text-[12px]">
              {history.map((h) => (
                <li key={h.id} className="flex gap-3">
                  <span className="cl-nums w-28 flex-none text-ink-3">
                    {fmtTs(h.changed_at)}
                  </span>
                  <span>
                    {h.old_status ? `${h.old_status} → ` : "created · "}
                    <strong>{h.new_status}</strong>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="self-start border-2 border-line-strong bg-surface p-4">
          <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-pink">
            Controls
          </div>
          <BookingControls
            id={booking.id}
            status={booking.status}
            docusignStatus={booking.docusign_status}
            paymentStatus={booking.payment_status}
            refundKind={invoice?.refund_kind ?? null}
            hasCharge={!!invoice?.qb_charge_id}
          />
        </div>
      </div>
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
