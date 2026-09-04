import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/requireStaff";
import { getCustomerDetail } from "@/lib/customers/queries";
import { BOOKING_STATUS_META } from "@/lib/bookings/state-machine";
import { BRAND_BADGE_CLASS } from "@/lib/design/tokens";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer · Crazy Larry's" };

function fmt(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
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

export default async function CustomerDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireStaff();
  const customer = await getCustomerDetail(params.id);
  if (!customer) notFound();

  return (
    <div className="flex flex-col gap-4 p-4 md:p-7">
      <Link href="/customers" className="text-[12px] font-extrabold text-ink-2 hover:text-ink">
        ← All customers
      </Link>

      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          {customer.full_name}
          {customer.company_name && (
            <span className="text-ink-2"> · {customer.company_name}</span>
          )}
        </h1>
        <p className="text-[12px] text-ink-2">
          {customer.is_registered ? "Has an account" : "Guest checkout"} · customer since{" "}
          {new Date(customer.created_at).toLocaleDateString(undefined, {
            month: "short",
            year: "numeric",
          })}
        </p>
      </div>

      <section className="border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
          Contact
        </div>
        <dl className="grid gap-4 p-4 sm:grid-cols-3">
          <div>
            <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
              Email
            </div>
            <div className="text-[14px] font-bold">{customer.email ?? "—"}</div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
              Phone
            </div>
            <div className="text-[14px] font-bold">{customer.phone ?? "—"}</div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
              Company
            </div>
            <div className="text-[14px] font-bold">{customer.company_name ?? "—"}</div>
          </div>
        </dl>
      </section>

      <section className="border-2 border-line-strong bg-surface">
        <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
          Booking history ({customer.bookings.length})
        </div>
        {customer.bookings.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-ink-2">No bookings yet.</p>
        ) : (
          <ul className="flex flex-col">
            {customer.bookings.map((b) => (
              <li key={b.id} className="border-b border-line last:border-b-0">
                <Link
                  href={`/bookings/${b.id}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] hover:bg-bg"
                >
                  <span className="w-16 font-extrabold">
                    {b.size_requested.replace("yd", " yd")}
                  </span>
                  <span className="cl-nums text-ink-2">{fmt(b.delivery_date)}</span>
                  <span
                    className={`px-2 py-0.5 text-[10px] font-extrabold uppercase ${BRAND_BADGE_CLASS[BOOKING_STATUS_META[b.status as keyof typeof BOOKING_STATUS_META]?.brand ?? "gray-st"]}`}
                  >
                    {BOOKING_STATUS_META[b.status as keyof typeof BOOKING_STATUS_META]?.label ?? b.status}
                  </span>
                  <span className="text-ink-2">{PAYMENT_LABEL[b.payment_status] ?? b.payment_status}</span>
                  <span className="cl-nums ml-auto font-extrabold">${b.total.toFixed(2)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
