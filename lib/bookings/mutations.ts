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
 * DEV-ONLY payment stub. Marks a booking "paid" for testing without QuickBooks
 * (Phase 5). Guarded by CL_ENABLE_DEV_STUBS — never enable in production.
 * For now it only records the intent on quickbooks_invoice_id as a sentinel;
 * no invoices row is written until Phase 5.
 */
export async function devSimulatePayment(id: string): Promise<void> {
  if (process.env.CL_ENABLE_DEV_STUBS !== "1") {
    throw new BookingMutationError(
      "Dev payment stub is disabled.",
      "stub_disabled",
    );
  }
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase
    .from("bookings")
    .update({ quickbooks_invoice_id: "DEV-STUB-PAID" })
    .eq("id", id);
  if (error) throw new BookingMutationError(error.message, "update_failed");
}
