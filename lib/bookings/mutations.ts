import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import {
  isBookingStatus,
  isDocusignStatus,
  type BookingStatus,
  type DocusignStatus,
} from "./state-machine";
import type { BookingRow } from "./types";

export class BookingMutationError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "BookingMutationError";
    this.code = code;
  }
}

function mapRpcError(e: { code?: string | null; message: string }): never {
  const map: Record<string, string> = {
    "42501": "You do not have permission to change this booking.",
    "23514": "That status change isn't allowed for this booking.",
    P0002: "That booking no longer exists.",
  };
  throw new BookingMutationError(
    map[e.code ?? ""] ?? e.message,
    e.code ?? "rpc_failed",
  );
}

export async function changeBookingStatus(
  id: string,
  to: string,
): Promise<{ booking: BookingRow; warning: string | null }> {
  await assertStaff();
  if (!isBookingStatus(to)) {
    throw new BookingMutationError("Unknown target status.", "bad_status");
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_booking_status", {
    p_booking_id: id,
    p_to: to as BookingStatus,
  });
  if (error) mapRpcError(error);

  // Cancelling an unpaid booking whose pay-link invoice was already emailed:
  // void that QBO invoice so the customer can't still pay it. Done after the
  // cancel (freeing the unit matters more); a void failure is surfaced, not
  // swallowed, so staff can void it by hand.
  let warning: string | null = null;
  if (to === "cancelled") {
    const { data: inv } = await supabase
      .from("invoices")
      .select("status, quickbooks_invoice_id")
      .eq("booking_id", id)
      .maybeSingle();
    if (inv?.status === "pending" && inv.quickbooks_invoice_id) {
      try {
        const { voidDrivewayFeeInvoice: voidQboInvoice } = await import(
          "@/lib/quickbooks/driveway-fee"
        );
        await voidQboInvoice(inv.quickbooks_invoice_id as string);
        await supabase
          .from("invoices")
          .update({ status: "failed", failure_reason: "Voided in QuickBooks — booking cancelled before payment" })
          .eq("booking_id", id);
      } catch (e) {
        warning = `Booking cancelled, but QuickBooks invoice ${inv.quickbooks_invoice_id} couldn't be voided (${(e as Error).message}) — void it in QuickBooks so the customer can't pay it.`;
      }
    }
  }
  return { booking: data as BookingRow, warning };
}

export async function setDocusignStatus(
  id: string,
  to: string,
): Promise<BookingRow> {
  await assertStaff();
  if (!isDocusignStatus(to)) {
    throw new BookingMutationError("Unknown agreement status.", "bad_status");
  }
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_booking_docusign_status", {
    p_booking_id: id,
    p_to: to as DocusignStatus,
  });
  if (error) mapRpcError(error);
  return data as BookingRow;
}

/**
 * Admin refund. Reads the stored charge id, calls the QuickBooks Payments
 * refund endpoint (Intuit decides void vs refund based on settlement), then
 * records it through the DB RPC.
 *
 *   cancel = false -> record_refund       (refund only; booking status untouched)
 *   cancel = true  -> cancel_and_refund   (refund + booking -> cancelled, atomic)
 *
 * Both RPCs re-check is_staff() against the caller's own session — this runs
 * with the staff cookie client, never the service role.
 */
export async function refundBooking(
  id: string,
  opts: { cancel: boolean },
): Promise<{ refundKind: "void" | "refund"; refundId: string }> {
  await assertStaff();
  const supabase = createClient();

  const { data: invoice, error: invErr } = await supabase
    .from("invoices")
    .select("qb_charge_id, qb_refund_id, amount, status")
    .eq("booking_id", id)
    .maybeSingle();
  if (invErr) throw new BookingMutationError(invErr.message, "invoice_read");
  if (!invoice) {
    throw new BookingMutationError(
      "No payment on file for this booking.",
      "no_invoice",
    );
  }
  if (invoice.status === "refunded" || invoice.qb_refund_id) {
    throw new BookingMutationError(
      "This payment has already been refunded.",
      "already_refunded",
    );
  }
  if (!invoice.qb_charge_id) {
    throw new BookingMutationError(
      "This booking wasn't paid by card at checkout (cash, check, or a QuickBooks invoice payment) — refund it in QuickBooks directly.",
      "no_charge",
    );
  }

  const amount = Number(invoice.amount).toFixed(2);

  // Lazy import keeps the Intuit layer out of bundles that never refund.
  const { refundCharge, PaymentError } = await import("@/lib/quickbooks/payments");
  let refund;
  try {
    refund = await refundCharge({ chargeId: invoice.qb_charge_id as string, amount });
  } catch (e) {
    if (e instanceof PaymentError) {
      throw new BookingMutationError(e.message, e.code);
    }
    throw e;
  }

  const rpc = opts.cancel ? "cancel_and_refund" : "record_refund";
  const { error: rpcErr } = await supabase.rpc(rpc, {
    p_booking_id: id,
    p_qb_refund_id: refund.refundId,
    p_refund_kind: refund.kind,
    p_amount: Number(amount),
  });
  if (rpcErr) {
    // The money is already back with the customer; the DB write failed.
    console.error(
      `[refundBooking] ${rpc} failed after successful QB refund ${refund.refundId} for booking ${id}:`,
      rpcErr.message,
    );
    mapRpcError(rpcErr);
  }

  return { refundKind: refund.kind, refundId: refund.refundId };
}

/**
 * Apply the driveway protection fee. Snapshots the current Settings rate onto
 * the booking (apply_driveway_fee), then creates a second, separate QBO
 * Invoice for it — never touches the original booking invoice or total, and
 * never re-charges the card (no card is kept on file after checkout). If the
 * QBO invoice creation fails, the DB write is rolled back (remove_driveway_fee)
 * so staff never see a half-applied state, mirroring checkout.ts's
 * compensating-refund-on-create_booking-failure pattern.
 */
export async function applyDrivewayFee(
  id: string,
  note: string | null,
): Promise<BookingRow> {
  await assertStaff();
  const supabase = createClient();

  const { data: booking, error: bErr } = await supabase
    .from("bookings")
    .select("driveway_fee_applied")
    .eq("id", id)
    .maybeSingle();
  if (bErr) throw new BookingMutationError(bErr.message, "booking_read");
  if (!booking) throw new BookingMutationError("Booking not found.", "not_found");
  if (booking.driveway_fee_applied) {
    throw new BookingMutationError(
      "Driveway fee is already applied to this booking.",
      "already_applied",
    );
  }

  const { data: settings, error: sErr } = await supabase
    .from("cl_pricing_settings")
    .select("driveway_fee_rate")
    .eq("id", true)
    .single();
  if (sErr || !settings) {
    throw new BookingMutationError(
      "Driveway fee rate isn't configured.",
      "no_rate",
    );
  }
  const amount = Number(settings.driveway_fee_rate);
  if (!(amount > 0)) {
    throw new BookingMutationError(
      "Set a driveway fee rate above $0 in Settings first.",
      "no_rate",
    );
  }

  const { error: applyErr } = await supabase.rpc("apply_driveway_fee", {
    p_booking_id: id,
    p_amount: amount,
    p_note: note,
  });
  if (applyErr) mapRpcError(applyErr);

  try {
    const { createDrivewayFeeInvoice } = await import(
      "@/lib/quickbooks/driveway-fee"
    );
    const qbInvoiceId = await createDrivewayFeeInvoice({
      bookingId: id,
      amount,
      note,
    });
    const { error: recErr } = await supabase.rpc("record_driveway_fee_invoice", {
      p_booking_id: id,
      p_qb_invoice_id: qbInvoiceId,
    });
    if (recErr) {
      // The QBO invoice DOES exist at this point — rolling back the applied
      // flag would orphan it untracked, which is worse than a saved id.
      console.error(
        `[applyDrivewayFee] record_driveway_fee_invoice failed for ${id} (QBO invoice ${qbInvoiceId} exists):`,
        recErr.message,
      );
      throw new BookingMutationError(
        `Fee applied and QuickBooks invoice ${qbInvoiceId} was created, but saving its id failed — note it manually.`,
        "invoice_id_not_recorded",
      );
    }
  } catch (e) {
    if (e instanceof BookingMutationError) throw e;
    // QBO invoice creation itself failed — nothing exists in QBO yet, so roll
    // the DB flag back rather than leave a fee "applied" with no invoice.
    await supabase.rpc("remove_driveway_fee", { p_booking_id: id });
    throw new BookingMutationError(
      `Couldn't create the QuickBooks invoice (${(e as Error).message}). Nothing was applied — try again.`,
      "qb_invoice_failed",
    );
  }

  const { data: finalRow, error: readErr } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr || !finalRow) {
    throw new BookingMutationError("Applied, but couldn't reload the booking.", "reload_failed");
  }
  return finalRow as BookingRow;
}

/**
 * Un-apply the driveway fee. Voids the QBO invoice first (if one was ever
 * recorded), then clears the flag — same void-before-write order as
 * refundBooking's QB-call-then-record-RPC shape.
 */
export async function removeDrivewayFee(id: string): Promise<BookingRow> {
  await assertStaff();
  const supabase = createClient();

  const { data: booking, error: bErr } = await supabase
    .from("bookings")
    .select("driveway_fee_applied, driveway_fee_qb_invoice_id")
    .eq("id", id)
    .maybeSingle();
  if (bErr) throw new BookingMutationError(bErr.message, "booking_read");
  if (!booking) throw new BookingMutationError("Booking not found.", "not_found");
  if (!booking.driveway_fee_applied) {
    throw new BookingMutationError(
      "Driveway fee isn't applied to this booking.",
      "not_applied",
    );
  }

  if (booking.driveway_fee_qb_invoice_id) {
    const { voidDrivewayFeeInvoice } = await import(
      "@/lib/quickbooks/driveway-fee"
    );
    try {
      await voidDrivewayFeeInvoice(booking.driveway_fee_qb_invoice_id as string);
    } catch (e) {
      throw new BookingMutationError(
        `Couldn't void the QuickBooks invoice (${(e as Error).message}). The fee is still applied — try again, or void it manually in QuickBooks.`,
        "qb_void_failed",
      );
    }
  }

  const { error: rpcErr } = await supabase.rpc("remove_driveway_fee", {
    p_booking_id: id,
  });
  if (rpcErr) mapRpcError(rpcErr);

  const { data: finalRow, error: readErr } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr || !finalRow) {
    throw new BookingMutationError("Removed, but couldn't reload the booking.", "reload_failed");
  }
  return finalRow as BookingRow;
}

/**
 * Staff mark a booking paid by cash or check. The DB write (who/when/method/
 * check #) is the source of truth and happens first; the matching QBO Payment
 * is posted right after, best-effort — if QuickBooks is down, sync_status
 * stays 'error'/'pending' and the daily sync retries it, same two-phase shape
 * as the card checkout.
 */
export async function recordManualPayment(
  id: string,
  opts: { method: string; reference: string | null; note: string | null },
): Promise<{ qboInvoiceId: string | null }> {
  await assertStaff();
  if (opts.method !== "cash" && opts.method !== "check") {
    throw new BookingMutationError("Pick cash or check.", "bad_method");
  }
  const supabase = createClient();
  const { error } = await supabase.rpc("record_manual_payment", {
    p_booking_id: id,
    p_method: opts.method,
    p_reference: opts.reference,
    p_note: opts.note,
  });
  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === "already_paid" || hint === "refunded" || hint === "cancelled") {
      throw new BookingMutationError(error.message, hint);
    }
    mapRpcError(error);
  }

  let qboInvoiceId: string | null = null;
  try {
    const { syncInvoiceForBooking } = await import("@/lib/quickbooks/invoices");
    qboInvoiceId = await syncInvoiceForBooking(id);
  } catch (e) {
    console.error(`[recordManualPayment] QBO sync threw for ${id}:`, (e as Error).message);
  }
  return { qboInvoiceId };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Email the customer a QuickBooks invoice with QBO's hosted Pay Now link, or
 * re-send the one already issued. QBO work first, then record_invoice_issued
 * on the staff session (audit = the real staff member). If the invoice was
 * created but the email failed, it's still recorded (so it's never orphaned
 * untracked in QBO) and staff see the send error with a Resend button.
 */
export async function sendBookingInvoice(
  id: string,
  sendToRaw: string,
): Promise<{ qbInvoiceId: string; invoiceLink: string | null; resent: boolean }> {
  await assertStaff();
  const sendTo = sendToRaw.trim();
  if (!EMAIL.test(sendTo)) {
    throw new BookingMutationError(
      "An email address is required — QuickBooks only generates a pay link for invoices with a customer email.",
      "no_email",
    );
  }
  const supabase = createClient();

  const { data: booking, error: bErr } = await supabase
    .from("bookings")
    .select("payment_status, status")
    .eq("id", id)
    .maybeSingle();
  if (bErr) throw new BookingMutationError(bErr.message, "booking_read");
  if (!booking) throw new BookingMutationError("Booking not found.", "not_found");
  if (booking.payment_status !== "unpaid") {
    throw new BookingMutationError("Only an unpaid booking can be invoiced.", "not_unpaid");
  }
  if (booking.status === "cancelled") {
    throw new BookingMutationError("This booking is cancelled.", "cancelled");
  }

  const { data: invoice } = await supabase
    .from("invoices")
    .select("status, quickbooks_invoice_id")
    .eq("booking_id", id)
    .maybeSingle();
  const existing =
    invoice?.status === "pending" ? ((invoice.quickbooks_invoice_id as string | null) ?? null) : null;

  const { createOrResendBookingInvoice } = await import("@/lib/quickbooks/invoice-payments");
  let r;
  try {
    r = await createOrResendBookingInvoice({ bookingId: id, sendTo, existingQbInvoiceId: existing });
  } catch (e) {
    throw new BookingMutationError(
      `Couldn't create the QuickBooks invoice (${(e as Error).message}). Nothing was sent — try again.`,
      "qb_invoice_failed",
    );
  }

  const { error: recErr } = await supabase.rpc("record_invoice_issued", {
    p_booking_id: id,
    p_qb_invoice_id: r.qbInvoiceId,
    p_invoice_link: r.invoiceLink,
    p_sent_to: r.sent ? sendTo : null,
  });
  if (recErr) {
    console.error(
      `[sendBookingInvoice] record_invoice_issued failed for ${id} (QBO invoice ${r.qbInvoiceId} exists):`,
      recErr.message,
    );
    throw new BookingMutationError(
      `QuickBooks invoice ${r.qbInvoiceId} was created${r.sent ? " and emailed" : ""}, but saving it here failed — note it manually.`,
      "invoice_id_not_recorded",
    );
  }

  if (!r.sent) {
    throw new BookingMutationError(
      `QuickBooks invoice ${r.qbInvoiceId} was created but the email didn't send (${r.sendError}). Use "Resend invoice" to try again.`,
      "send_failed",
    );
  }
  return { qbInvoiceId: r.qbInvoiceId, invoiceLink: r.invoiceLink, resent: !r.created };
}

/** Staff "Check payment now" — polls QBO for just this booking's invoice. */
export async function checkInvoicePayment(id: string): Promise<{ paid: boolean; problem: string | null }> {
  await assertStaff();
  const { reconcileInvoicePayments } = await import("@/lib/quickbooks/invoice-payments");
  let r;
  try {
    r = await reconcileInvoicePayments([id]);
  } catch (e) {
    throw new BookingMutationError(
      `Couldn't reach QuickBooks (${(e as Error).message}).`,
      "qb_check_failed",
    );
  }
  return {
    paid: r.paid.includes(id),
    problem: r.problems.find((p) => p.bookingId === id)?.reason ?? null,
  };
}
