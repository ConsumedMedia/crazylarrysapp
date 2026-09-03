import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { quickbooksJson } from "./client";

/**
 * QuickBooks Online invoice sync (Accounting API).
 *
 * Phase 2 of the two-phase payment design: the charge is already recorded
 * (invoices row, sync_status='pending', bookings.payment_status='paid'). This
 * creates the matching QBO Invoice + a Payment that marks it paid, then calls
 * record_invoice_synced. Every failure path leaves sync_status as 'pending' /
 * 'error' for the reconcile cron to retry — it never throws to the checkout.
 */

interface QueryResponse<T> {
  QueryResponse: { [k: string]: T[] | number | undefined };
}

async function qboQuery<T>(entity: string, whereClause: string): Promise<T[]> {
  const sql = `select * from ${entity} ${whereClause} MAXRESULTS 1`;
  const data = await quickbooksJson<QueryResponse<T>>(
    `query?query=${encodeURIComponent(sql)}`,
    { method: "GET" },
  );
  const rows = data.QueryResponse?.[entity] as T[] | undefined;
  return Array.isArray(rows) ? rows : [];
}

function esc(v: string): string {
  return v.replace(/'/g, "\\'");
}

/** Find a QBO customer by email (falls back to display name), else create one. */
async function findOrCreateCustomer(opts: {
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<string> {
  if (opts.email) {
    const byEmail = await qboQuery<{ Id: string }>(
      "Customer",
      `where PrimaryEmailAddr = '${esc(opts.email)}'`,
    );
    if (byEmail[0]?.Id) return byEmail[0].Id;
  }
  const byName = await qboQuery<{ Id: string }>(
    "Customer",
    `where DisplayName = '${esc(opts.name)}'`,
  );
  if (byName[0]?.Id) return byName[0].Id;

  const created = await quickbooksJson<{ Customer: { Id: string } }>("customer", {
    method: "POST",
    body: JSON.stringify({
      DisplayName: opts.name,
      ...(opts.email
        ? { PrimaryEmailAddr: { Address: opts.email } }
        : {}),
      ...(opts.phone ? { PrimaryPhone: { FreeFormNumber: opts.phone } } : {}),
    }),
  });
  return created.Customer.Id;
}

/**
 * The named service items the invoice lines hang on. We keep two so Larry's
 * books split rental revenue from collected sales tax. Found by exact name or
 * created against the first income account.
 */
const ITEM_RENTAL = "Dumpster Rental";
const ITEM_TAX = "Sales Tax Collected";

async function resolveItem(name: string): Promise<string> {
  const existing = await qboQuery<{ Id: string }>(
    "Item",
    `where Name = '${esc(name)}'`,
  );
  if (existing[0]?.Id) return existing[0].Id;

  const incomeAcct = await qboQuery<{ Id: string }>(
    "Account",
    "where AccountType = 'Income' and Active = true",
  );
  if (!incomeAcct[0]?.Id) {
    throw new Error("No QBO income account to attach a service item to");
  }
  const created = await quickbooksJson<{ Item: { Id: string } }>("item", {
    method: "POST",
    body: JSON.stringify({
      Name: name,
      Type: "Service",
      IncomeAccountRef: { value: incomeAcct[0].Id },
    }),
  });
  return created.Item.Id;
}

/**
 * Create (or complete) the QBO invoice for a paid booking. Idempotent-ish:
 * if invoices.quickbooks_invoice_id is already set, it's a no-op.
 * Returns the QBO invoice id, or null on any failure (logged, non-fatal).
 */
export async function syncInvoiceForBooking(
  bookingId: string,
): Promise<string | null> {
  const service = createServiceClient();

  const { data: booking } = await service
    .from("bookings")
    .select(
      "id, customer_id, size_requested, delivery_date, subtotal, tax, total, quickbooks_invoice_id",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return null;
  if (booking.quickbooks_invoice_id) return booking.quickbooks_invoice_id as string;

  const { data: invoiceRow } = await service
    .from("invoices")
    .select("id, amount, qb_charge_id, qb_payment_id")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!invoiceRow) return null;

  const { data: customer } = await service
    .from("customers")
    .select("full_name, email, phone")
    .eq("id", booking.customer_id)
    .maybeSingle();

  try {
    const customerRef = await findOrCreateCustomer({
      name: (customer?.full_name as string) ?? "Online booking",
      email: (customer?.email as string | null) ?? null,
      phone: (customer?.phone as string | null) ?? null,
    });
    const rentalItem = await resolveItem(ITEM_RENTAL);

    const subtotal = Number(booking.subtotal);
    const tax = Number(booking.tax);
    const total = Number(booking.total);

    // Tax is carried as its own non-taxable line rather than TxnTaxDetail:
    // QBO's Automated Sales Tax ignores a passed TotalTax, which would leave
    // the QBO invoice total ($subtotal) out of sync with the amount charged
    // ($total). A flat line keeps the totals equal.
    const lines: unknown[] = [
      {
        DetailType: "SalesItemLineDetail",
        Amount: subtotal,
        Description: `${String(booking.size_requested).replace("yd", " yd")} dumpster rental — delivery ${booking.delivery_date}`,
        SalesItemLineDetail: {
          ItemRef: { value: rentalItem },
          Qty: 1,
          UnitPrice: subtotal,
          TaxCodeRef: { value: "NON" },
        },
      },
    ];
    if (tax > 0) {
      const taxItem = await resolveItem(ITEM_TAX);
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: tax,
        Description: "Ohio sales tax",
        SalesItemLineDetail: {
          ItemRef: { value: taxItem },
          Qty: 1,
          UnitPrice: tax,
          TaxCodeRef: { value: "NON" },
        },
      });
    }

    const invoice = await quickbooksJson<{ Invoice: { Id: string } }>("invoice", {
      method: "POST",
      body: JSON.stringify({
        CustomerRef: { value: customerRef },
        TxnDate: booking.delivery_date,
        Line: lines,
        PrivateNote: `Crazy Larry's booking ${bookingId}. Paid by card (charge ${invoiceRow.qb_charge_id ?? "n/a"}). Total $${total.toFixed(2)}.`,
      }),
    });
    const qbInvoiceId = invoice.Invoice.Id;

    // Mark it paid in QBO with a linked Payment.
    let qbPaymentId: string | null = null;
    try {
      const payment = await quickbooksJson<{ Payment: { Id: string } }>("payment", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerRef },
          TotalAmt: total,
          Line: [
            {
              Amount: total,
              LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }],
            },
          ],
        }),
      });
      qbPaymentId = payment.Payment.Id;
    } catch (e) {
      console.error(
        `[quickbooks/invoices] payment link failed for ${bookingId}:`,
        (e as Error).message,
      );
    }

    const { error: rpcErr } = await service.rpc("record_invoice_synced", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbInvoiceId,
    });
    if (rpcErr) throw new Error(`record_invoice_synced: ${rpcErr.message}`);

    if (qbPaymentId) {
      await service
        .from("invoices")
        .update({ qb_payment_id: qbPaymentId })
        .eq("booking_id", bookingId);
    }

    return qbInvoiceId;
  } catch (e) {
    console.error(
      `[quickbooks/invoices] sync failed for ${bookingId}:`,
      (e as Error).message,
    );
    await service
      .from("invoices")
      .update({ sync_status: "error", failure_reason: (e as Error).message.slice(0, 300) })
      .eq("booking_id", bookingId);
    return null;
  }
}
