import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { quickbooksJson } from "./client";
import { findOrCreateCustomer, resolveItem } from "./invoices";

/**
 * The driveway protection fee is never charged via the card on file (there
 * isn't one kept after checkout) — it's billed as its own separate, unpaid
 * QBO Invoice (AR), the same thing the office would create manually. The
 * original booking invoice (invoices.ts) is never touched.
 */

const ITEM_DRIVEWAY_FEE = "Driveway Protection Fee";

export async function createDrivewayFeeInvoice(opts: {
  bookingId: string;
  amount: number;
  note: string | null;
}): Promise<string> {
  const service = createServiceClient();

  const { data: booking } = await service
    .from("bookings")
    .select("customer_id, delivery_address, delivery_date")
    .eq("id", opts.bookingId)
    .maybeSingle();
  if (!booking) throw new Error(`Booking ${opts.bookingId} not found`);

  const { data: customer } = await service
    .from("customers")
    .select("full_name, email, phone")
    .eq("id", booking.customer_id as string)
    .maybeSingle();

  const customerRef = await findOrCreateCustomer({
    name: (customer?.full_name as string) ?? "Crazy Larry's customer",
    email: (customer?.email as string | null) ?? null,
    phone: (customer?.phone as string | null) ?? null,
  });
  const feeItem = await resolveItem(ITEM_DRIVEWAY_FEE);

  const invoice = await quickbooksJson<{ Invoice: { Id: string } }>("invoice", {
    method: "POST",
    body: JSON.stringify({
      CustomerRef: { value: customerRef },
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: opts.amount,
          Description: opts.note
            ? `Driveway protection fee — ${opts.note}`
            : "Driveway protection fee",
          SalesItemLineDetail: {
            ItemRef: { value: feeItem },
            Qty: 1,
            UnitPrice: opts.amount,
            TaxCodeRef: { value: "NON" },
          },
        },
      ],
      PrivateNote: `Crazy Larry's booking ${opts.bookingId} — driveway protection fee applied by staff. Not charged via card; collect separately (call, in person, or send this invoice).`,
    }),
  });

  return invoice.Invoice.Id;
}

/** Void the second invoice on un-apply. Requires the current SyncToken. */
export async function voidDrivewayFeeInvoice(qbInvoiceId: string): Promise<void> {
  const current = await quickbooksJson<{ Invoice: { SyncToken: string } }>(
    `invoice/${qbInvoiceId}`,
  );
  await quickbooksJson("invoice?operation=void", {
    method: "POST",
    body: JSON.stringify({
      Id: qbInvoiceId,
      SyncToken: current.Invoice.SyncToken,
    }),
  });
}
