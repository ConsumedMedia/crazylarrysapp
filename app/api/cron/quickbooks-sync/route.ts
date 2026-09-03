import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { syncInvoiceForBooking } from "@/lib/quickbooks/invoices";
import { quickBooksConfigured } from "@/lib/quickbooks/config";

export const dynamic = "force-dynamic";

/**
 * Reconcile job — phase 2 backstop for the two-phase payment design.
 *
 * Sweeps invoices whose QBO invoice was never created (sync_status pending/error)
 * and retries. Every paid booking eventually gets its QBO invoice even if the
 * synchronous attempt at checkout failed (transient API error, rate limit,
 * token hiccup).
 *
 *   GET /api/cron/quickbooks-sync
 *   Authorization: Bearer $CL_CRON_SECRET
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!quickBooksConfigured()) {
    return NextResponse.json({ skipped: "not_configured" });
  }

  const service = createServiceClient();
  const { data: pending, error } = await service
    .from("invoices")
    .select("booking_id")
    .in("sync_status", ["pending", "error"])
    .eq("status", "paid")
    .limit(25);

  if (error) {
    console.error("[cron/quickbooks-sync]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: Array<{ bookingId: string; invoiceId: string | null }> = [];
  for (const row of pending ?? []) {
    const invoiceId = await syncInvoiceForBooking(row.booking_id as string);
    results.push({ bookingId: row.booking_id as string, invoiceId });
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    synced: results.filter((r) => r.invoiceId).length,
    results,
  });
}
