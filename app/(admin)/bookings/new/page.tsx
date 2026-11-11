import Link from "next/link";
import { requireStaff } from "@/lib/auth/requireStaff";
import { getPricingConfig } from "@/lib/bookings/pricing";
import { pickCustomer } from "@/lib/customers/search";
import { NewBookingForm } from "./_components/NewBookingForm";
import { PayLinkBookingForm } from "./_components/PayLinkBookingForm";
import { getPayLinkSettings } from "@/lib/pay-links/settings";
import { getDeliveryFloor } from "@/lib/bookings/cutoff";

export const dynamic = "force-dynamic";
export const metadata = { title: "New booking · Crazy Larry's" };

export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: { customer?: string };
}) {
  await requireStaff();
  const pricing = await getPricingConfig();
  // The pay-link switch (cl_pay_link_settings.enabled). Off = today's form, unchanged.
  const { enabled: payLinksOn } = await getPayLinkSettings();
  // The order cutoff matters only to the pay-link button; the phone form never reads it.
  const floor = payLinksOn ? await getDeliveryFloor() : null;
  // ?customer=<id> (from a customer's page) starts the form as if staff had
  // picked that customer: same details, address options and consent on file.
  const customer =
    searchParams.customer && /^[0-9a-f-]{36}$/i.test(searchParams.customer)
      ? await pickCustomer(searchParams.customer)
      : null;

  const formCustomer = customer;

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
        {payLinksOn ? (
          <p className="text-[12px] text-ink-2">
            For phone and in-person orders. Book creates the booking and sends
            the customer a link to pay by card.
          </p>
        ) : (
          <p className="text-[12px] text-ink-2">
            For phone and in-person orders. No payment is taken here — the
            booking starts unpaid; record cash/check or send a QuickBooks
            invoice from the booking page.
          </p>
        )}
      </div>
      {payLinksOn ? (
        <PayLinkBookingForm pricing={pricing} customer={formCustomer} floor={floor} />
      ) : (
        <NewBookingForm pricing={pricing} customer={formCustomer} />
      )}
    </div>
  );
}
