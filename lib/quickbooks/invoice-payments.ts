import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { quickbooksFetch, quickbooksJson } from "./client";
import { bookingInvoiceLines, findOrCreateCustomer } from "./invoices";

/**
 * Unpaid-booking invoicing via QuickBooks' own hosted "Pay Now" page.
 *
 * Staff-created bookings (lib/bookings/staff-create.ts) start unpaid. Staff
 * can email the customer a QBO Invoice with online payment enabled; the
 * customer pays on Intuit's page (card / ACH, plus PayPal/Venmo and whatever
 * wallets Intuit shows when the company is onboarded for them — none of that
 * is reachable through our own card checkout). We never see the payment
 * itself: QBO applies it to the invoice, and reconcileInvoicePayments()
 * notices Invoice.Balance reach 0.
 *
 * Verified against the Intuit Invoice reference (2026-09-23):
 *  - AllowOnlineCreditCardPayment / AllowOnlineACHPayment: active only when
 *    Preferences.SalesFormsPrefs.ETransactionPaymentEnabled is true.
 *    AllowOnlinePayPalPayment defaults to the company's PayPal subscription
 *    status, so it's left unset.
 *  - POST invoice/<id>/send?sendTo=<email>, Content-Type
 *    application/octet-stream -> EmailStatus=EmailSent.
 *  - InvoiceLink is returned only with include=invoiceLink, and only for
 *    invoices with online payment enabled AND a valid customer email.
 *  - Balance: "A Balance of 0 indicates the invoice is fully paid."
 */

const MINOR_VERSION = "75";

interface QboInvoice {
  Id: string;
  Balance: number;
  TotalAmt: number;
  InvoiceLink?: string;
  EmailStatus?: string;
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
}

export class InvoiceSendError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "InvoiceSendError";
    this.code = code;
  }
}

async function readInvoice(qbInvoiceId: string): Promise<QboInvoice> {
  const r = await quickbooksJson<{ Invoice: QboInvoice }>(
    `invoice/${qbInvoiceId}?include=invoiceLink&minorversion=${MINOR_VERSION}`,
  );
  return r.Invoice;
}

/**
 * Create (first time) or re-send (after that) the pay-link invoice for an
 * unpaid booking. Does NOT write to our DB — the caller records the result
 * with the staff session via record_invoice_issued, so auth.uid() stays the
 * real staff member.
 *
 * If the invoice gets created but the email step fails, returns
 * { sent: false, sendError } rather than throwing, so the caller still
 * records the QBO invoice id (a created-but-untracked QBO invoice would be
 * the worst outcome).
 */
export async function createOrResendBookingInvoice(opts: {
  bookingId: string;
  sendTo: string;
  existingQbInvoiceId: string | null;
  /** false = create/read only, no email (integration tests' safe mode). */
  send?: boolean;
}): Promise<{
  qbInvoiceId: string;
  invoiceLink: string | null;
  sent: boolean;
  sendError: string | null;
  created: boolean;
}> {
  const service = createServiceClient();
  const { data: booking } = await service
    .from("bookings")
    .select("id, customer_id, size_requested, delivery_date, subtotal, tax, total")
    .eq("id", opts.bookingId)
    .maybeSingle();
  if (!booking) throw new InvoiceSendError("Booking not found.", "not_found");

  let qbInvoiceId = opts.existingQbInvoiceId;
  let created = false;

  if (!qbInvoiceId) {
    const { data: customer } = await service
      .from("customers")
      .select("full_name, email, phone")
      .eq("id", booking.customer_id)
      .maybeSingle();
    const customerRef = await findOrCreateCustomer({
      name: (customer?.full_name as string) ?? "Crazy Larry's customer",
      email: opts.sendTo,
      phone: (customer?.phone as string | null) ?? null,
    });
    const inv = await quickbooksJson<{ Invoice: { Id: string } }>(
      `invoice?minorversion=${MINOR_VERSION}`,
      {
        method: "POST",
        body: JSON.stringify({
          CustomerRef: { value: customerRef },
          TxnDate: new Date().toISOString().slice(0, 10),
          Line: await bookingInvoiceLines(booking),
          BillEmail: { Address: opts.sendTo },
          AllowOnlineCreditCardPayment: true,
          AllowOnlineACHPayment: true,
          CustomerMemo: {
            value: `Dumpster rental — delivery ${booking.delivery_date}. Thank you for choosing Crazy Larry's!`,
          },
          PrivateNote: `Crazy Larry's booking ${opts.bookingId}. Staff-created booking; unpaid at creation, pay-link invoice.`,
        }),
      },
    );
    qbInvoiceId = inv.Invoice.Id;
    created = true;
  }

  let sent = false;
  let sendError: string | null = null;
  if (opts.send !== false) try {
    const res = await quickbooksFetch(
      `invoice/${qbInvoiceId}/send?sendTo=${encodeURIComponent(opts.sendTo)}&minorversion=${MINOR_VERSION}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
      },
    );
    if (!res.ok) {
      sendError = `QuickBooks API ${res.status}: ${(await res.text()).slice(0, 300)}`;
    } else {
      sent = true;
    }
  } catch (e) {
    sendError = (e as Error).message;
  }

  let invoiceLink: string | null = null;
  try {
    invoiceLink = (await readInvoice(qbInvoiceId)).InvoiceLink ?? null;
  } catch (e) {
    console.error(
      `[quickbooks/invoice-payments] invoiceLink read failed for ${qbInvoiceId}:`,
      (e as Error).message,
    );
  }

  return { qbInvoiceId, invoiceLink, sent, sendError, created };
}

export interface ReconcileResult {
  checked: number;
  paid: string[];          // booking ids flipped to paid by this run
  partial: string[];       // balance dropped but not to 0
  problems: Array<{ bookingId: string; reason: string }>;
}

/**
 * Poll QBO for every outstanding pay-link invoice (invoices.status='pending'
 * with a QBO id on an unpaid booking) and record the ones QBO shows fully
 * paid. One QBO query per 50 invoices. Called by the daily sync and by the
 * staff "Check payment now" button (with bookingIds = [that booking]).
 *
 * record_invoice_payment_detected re-checks payment_status under a row lock,
 * so a cash/check entry by staff in the meantime always wins cleanly.
 */
export async function reconcileInvoicePayments(
  bookingIds?: string[],
): Promise<ReconcileResult> {
  const service = createServiceClient();
  let q = service
    .from("invoices")
    .select("booking_id, quickbooks_invoice_id, amount, bookings!inner(payment_status)")
    .eq("status", "pending")
    .not("quickbooks_invoice_id", "is", null)
    .eq("bookings.payment_status", "unpaid")
    .limit(200);
  if (bookingIds?.length) q = q.in("booking_id", bookingIds);
  const { data: rows, error } = await q;
  if (error) throw new Error(`reconcileInvoicePayments: ${error.message}`);

  const result: ReconcileResult = { checked: 0, paid: [], partial: [], problems: [] };
  const pending = (rows ?? []).map((r) => ({
    bookingId: r.booking_id as string,
    qbInvoiceId: r.quickbooks_invoice_id as string,
    amount: Number(r.amount),
  }));

  for (let i = 0; i < pending.length; i += 50) {
    const chunk = pending.slice(i, i + 50);
    const ids = chunk.map((p) => `'${p.qbInvoiceId.replace(/'/g, "")}'`).join(",");
    const sql = `select * from Invoice where Id in (${ids}) MAXRESULTS 1000`;
    const data = await quickbooksJson<{ QueryResponse: { Invoice?: QboInvoice[] } }>(
      `query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`,
      { method: "GET" },
    );
    const byId = new Map((data.QueryResponse.Invoice ?? []).map((inv) => [inv.Id, inv]));

    for (const p of chunk) {
      result.checked++;
      const inv = byId.get(p.qbInvoiceId);
      const now = new Date().toISOString();

      if (!inv) {
        const reason = `QBO invoice ${p.qbInvoiceId} not found (deleted in QuickBooks?)`;
        result.problems.push({ bookingId: p.bookingId, reason });
        await service
          .from("invoices")
          .update({ failure_reason: reason, qb_checked_at: now })
          .eq("booking_id", p.bookingId);
        continue;
      }

      const total = Number(inv.TotalAmt);
      const balance = Number(inv.Balance);

      if (total <= 0) {
        // A voided QBO invoice reads back with TotalAmt 0 — not a payment.
        const reason = `QBO invoice ${p.qbInvoiceId} was voided in QuickBooks`;
        result.problems.push({ bookingId: p.bookingId, reason });
        await service
          .from("invoices")
          .update({ failure_reason: reason, qb_balance: balance, qb_checked_at: now })
          .eq("booking_id", p.bookingId);
        continue;
      }

      if (balance <= 0) {
        const payments = (inv.LinkedTxn ?? []).filter((t) => t.TxnType === "Payment");
        const qbPaymentId = payments.at(-1)?.TxnId ?? null;
        const { data: flipped, error: rpcErr } = await service.rpc(
          "record_invoice_payment_detected",
          {
            p_booking_id: p.bookingId,
            p_qb_invoice_id: p.qbInvoiceId,
            p_qb_payment_id: qbPaymentId,
          },
        );
        if (rpcErr) {
          result.problems.push({ bookingId: p.bookingId, reason: rpcErr.message });
        } else if (flipped) {
          result.paid.push(p.bookingId);
        }
        continue;
      }

      if (balance < total) result.partial.push(p.bookingId);
      await service
        .from("invoices")
        .update({ qb_balance: balance, qb_checked_at: now })
        .eq("booking_id", p.bookingId);
    }
  }

  return result;
}
