import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { getPricingConfig } from "@/lib/bookings/pricing";
import { getCustomerDetail } from "@/lib/customers/queries";
import { NewBookingForm } from "./_components/NewBookingForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "New booking · Crazy Larry's" };

export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: { customer?: string };
}) {
  await requireStaff();
  const pricing = await getPricingConfig();
  const customer = searchParams.customer
    ? await getCustomerDetail(searchParams.customer)
    : null;

  return (
    <div className="cl-fade-in flex flex-col gap-4 p-4 md:p-7">
      <Link
        href="/bookings"
        className="text-[12px] font-extrabold text-ink-2 hover:text-ink"
      >
        ← All bookings
      </Link>
      <div>
        <h1 className="text-[21px] font-extrabold leading-tight tracking-[-0.02em] md:text-[30px]">
          New booking
        </h1>
        <p className="text-[12px] text-ink-2">
          For phone and in-person orders. No payment is taken here — the
          booking starts unpaid; record cash/check or send a QuickBooks
          invoice from the booking page.
        </p>
      </div>
      <NewBookingForm
        pricing={pricing}
        customer={
          customer
            ? {
                id: customer.id,
                fullName: customer.full_name,
                email: customer.email,
                phone: customer.phone,
                companyName: customer.company_name,
              }
            : null
        }
      />
    </div>
  );
}
