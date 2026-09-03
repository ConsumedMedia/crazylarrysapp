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
): Promise<BookingRow> {
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
  return data as BookingRow;
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
      "This booking has no QuickBooks charge to refund (was it paid another way?).",
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
