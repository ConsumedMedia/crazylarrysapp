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
export async function findOrCreateCustomer(opts: {
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

export async function resolveItem(name: string): Promise<string> {
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

/** Resolve a QBO PaymentMethod ("Cash", "Check") by name; null if the company has none. */
async function resolvePaymentMethod(name: string): Promise<string | null> {
  const rows = await qboQuery<{ Id: string }>(
    "PaymentMethod",
    `where Name = '${esc(name)}'`,
  );
  return rows[0]?.Id ?? null;
}

/** Build the rental + tax lines for a booking's QBO invoice. */
export async function bookingInvoiceLines(booking: {
  size_requested: string;
  delivery_date: string;
  subtotal: number | string;
  tax: number | string;
}): Promise<unknown[]> {
  const rentalItem = await resolveItem(ITEM_RENTAL);
  const subtotal = Number(booking.subtotal);
  const tax = Number(booking.tax);

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
  return lines;
}

/**
 * Bring QBO in line with a PAID booking. Idempotent: once sync_status is
 * 'synced' it's a no-op. Handles every way a booking gets paid:
 *
 *  - card (online checkout): create invoice + a Payment that marks it paid.
 *  - cash/check with no QBO invoice yet: same, with PaymentMethodRef and
 *    PaymentRefNum (check #) on the Payment.
 *  - cash/check after a pay-link invoice was already sent: post only the
 *    Payment against that existing invoice, so its balance goes to 0 and the
 *    customer's link stops asking for money. If QBO already shows the invoice
 *    fully paid (the customer paid online as well) nothing is posted and the
 *    row is flagged 'error' with a possible-double-payment reason for staff.
 *  - qbo_invoice: QBO recorded the payment itself; always already synced.
 *
 * Returns the QBO invoice id, or null on any failure (logged, non-fatal; the
 * daily sync retries sync_status in ('pending','error')).
 */
export async function syncInvoiceForBooking(
  bookingId: string,
): Promise<string | null> {
  const service = createServiceClient();

  const { data: invoiceRow } = await service
    .from("invoices")
    .select(
      "id, amount, status, qb_charge_id, qb_payment_id, quickbooks_invoice_id, sync_status, payment_method, payment_reference, paid_at",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!invoiceRow || invoiceRow.status !== "paid") return null;
  if (invoiceRow.sync_status === "synced" && invoiceRow.quickbooks_invoice_id) {
    return invoiceRow.quickbooks_invoice_id as string;
  }

  const { data: booking } = await service
    .from("bookings")
    .select("id, customer_id, size_requested, delivery_date, subtotal, tax, total")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return null;

  const { data: customer } = await service
    .from("customers")
    .select("full_name, email, phone")
    .eq("id", booking.customer_id)
    .maybeSingle();

  const method = (invoiceRow.payment_method as string | null) ?? "card";
  const reference = (invoiceRow.payment_reference as string | null) ?? null;
  const total = Number(booking.total);

  try {
    const customerRef = await findOrCreateCustomer({
      name: (customer?.full_name as string) ?? "Online booking",
      email: (customer?.email as string | null) ?? null,
      phone: (customer?.phone as string | null) ?? null,
    });

    // An invoice already exists in QBO when a pay link was sent before the
    // customer paid cash/check (or a previous attempt got this far).
    let qbInvoiceId = (invoiceRow.quickbooks_invoice_id as string | null) ?? null;

    if (qbInvoiceId && !invoiceRow.qb_payment_id) {
      const existing = await quickbooksJson<{ Invoice: { Balance: number } }>(
        `invoice/${qbInvoiceId}`,
      );
      if (Number(existing.Invoice.Balance) <= 0) {
        const reason = `QBO invoice ${qbInvoiceId} already shows paid in QuickBooks, but ${method} was also recorded here — possible double payment. Check QuickBooks before refunding either.`;
        await service
          .from("invoices")
          .update({ sync_status: "error", failure_reason: reason })
          .eq("booking_id", bookingId);
        console.error(`[quickbooks/invoices] ${bookingId}: ${reason}`);
        return null;
      }
    }

    if (!qbInvoiceId) {
      const methodNote =
        method === "card"
          ? `Paid by card (charge ${invoiceRow.qb_charge_id ?? "n/a"})`
          : `Paid by ${method}${reference ? ` #${reference}` : ""}, recorded by staff`;
      const invoice = await quickbooksJson<{ Invoice: { Id: string } }>("invoice", {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerRef },
          TxnDate: booking.delivery_date,
          Line: await bookingInvoiceLines(booking),
          PrivateNote: `Crazy Larry's booking ${bookingId}. ${methodNote}. Total $${total.toFixed(2)}.`,
        }),
      });
      qbInvoiceId = invoice.Invoice.Id;
    }

    // Mark it paid in QBO with a linked Payment (unless an earlier attempt
    // already posted one).
    let qbPaymentId = (invoiceRow.qb_payment_id as string | null) ?? null;
    if (!qbPaymentId) {
      try {
        const methodRef =
          method === "cash" || method === "check"
            ? await resolvePaymentMethod(method === "cash" ? "Cash" : "Check")
            : null;
        const payment = await quickbooksJson<{ Payment: { Id: string } }>("payment", {
          method: "POST",
          body: JSON.stringify({
            CustomerRef: { value: customerRef },
            TotalAmt: total,
            ...(method !== "card" && invoiceRow.paid_at
              ? { TxnDate: String(invoiceRow.paid_at).slice(0, 10) }
              : {}),
            ...(methodRef ? { PaymentMethodRef: { value: methodRef } } : {}),
            ...(reference ? { PaymentRefNum: reference.slice(0, 21) } : {}),
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
        // The card path has always tolerated this (the charge is real either
        // way). For cash/check the Payment IS the sync — leave it for retry,
        // keeping the invoice id so the retry doesn't create a second one.
        if (method !== "card") {
          await service
            .from("invoices")
            .update({
              quickbooks_invoice_id: qbInvoiceId,
              sync_status: "error",
              failure_reason: `QBO payment post failed: ${(e as Error).message}`.slice(0, 300),
            })
            .eq("booking_id", bookingId);
          return null;
        }
      }
    }

    const { error: rpcErr } = await service.rpc("record_invoice_synced", {
      p_booking_id: bookingId,
      p_qb_invoice_id: qbInvoiceId,
    });
    if (rpcErr) throw new Error(`record_invoice_synced: ${rpcErr.message}`);

    if (qbPaymentId) {
      await service
        .from("invoices")
        .update({ qb_payment_id: qbPaymentId, failure_reason: null })
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
