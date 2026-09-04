import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import {
  notifyOverdue,
  notifyDeliveryReminder,
  notifyPickupReminder,
  alreadyNotified,
} from "@/lib/notifications/notify";
import { getValidAccessToken } from "@/lib/quickbooks/tokens";
import { syncInvoiceForBooking } from "@/lib/quickbooks/invoices";
import { quickBooksConfigured } from "@/lib/quickbooks/config";

/**
 * The actual work behind each /api/cron/* route, pulled into plain functions
 * so /api/cron/daily can call all four in sequence (one Vercel Cron job,
 * Hobby-plan legal) while the individual routes stay callable on their own
 * for manual testing. Each function returns a JSON-serializable summary and
 * does not throw for expected/skip conditions — only for genuine failures,
 * which the caller (a route handler, or /api/cron/daily's try/catch) turns
 * into an error entry rather than a crashed request.
 */

// --- overdue ----------------------------------------------------------------

export async function runOverdue(): Promise<{
  marked_overdue: number;
  booking_ids: string[];
}> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("mark_overdue_bookings");
  if (error) throw new Error(`mark_overdue_bookings: ${error.message}`);

  const ids: string[] = Array.isArray(data)
    ? data
        .map((r: unknown) =>
          typeof r === "string"
            ? r
            : ((r as { mark_overdue_bookings?: string }).mark_overdue_bookings ?? ""),
        )
        .filter(Boolean)
    : [];

  for (const id of ids) {
    await notifyOverdue(id);
  }

  return { marked_overdue: ids.length, booking_ids: ids };
}

// --- reminders --------------------------------------------------------------

export async function runReminders(): Promise<{
  date: string;
  delivery_reminders: { sent: number; skipped: number };
  pickup_reminders: { sent: number; skipped: number };
  errors: string[];
}> {
  const service = createServiceClient();
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);

  const [deliveries, pickups] = await Promise.all([
    service.from("bookings").select("id").eq("delivery_date", tomorrow).eq("status", "confirmed"),
    service
      .from("bookings")
      .select("id")
      .eq("pickup_date", tomorrow)
      .in("status", ["active", "pickup_scheduled"]),
  ]);

  const out = {
    date: tomorrow,
    delivery_reminders: { sent: 0, skipped: 0 },
    pickup_reminders: { sent: 0, skipped: 0 },
    errors: [] as string[],
  };

  if (deliveries.error) out.errors.push(`deliveries: ${deliveries.error.message}`);
  if (pickups.error) out.errors.push(`pickups: ${pickups.error.message}`);

  for (const row of deliveries.data ?? []) {
    const id = row.id as string;
    if (await alreadyNotified(id, "delivery_reminder")) {
      out.delivery_reminders.skipped++;
      continue;
    }
    await notifyDeliveryReminder(id);
    out.delivery_reminders.sent++;
  }

  for (const row of pickups.data ?? []) {
    const id = row.id as string;
    if (await alreadyNotified(id, "pickup_reminder")) {
      out.pickup_reminders.skipped++;
      continue;
    }
    await notifyPickupReminder(id);
    out.pickup_reminders.sent++;
  }

  return out;
}

// --- quickbooks-refresh -------------------------------------------------

export async function runQuickbooksRefresh(): Promise<{
  ok: boolean;
  refreshed?: boolean;
  skipped?: string;
  error?: string;
}> {
  if (!quickBooksConfigured()) return { ok: true, skipped: "not_configured" };

  try {
    const { refreshed } = await getValidAccessToken(24 * 60 * 60);
    return { ok: true, refreshed };
  } catch (e) {
    const message = (e as Error).message;
    if (message === "QuickBooks is not connected") {
      return { ok: true, skipped: "not_connected" };
    }
    return { ok: false, error: message };
  }
}

// --- quickbooks-sync ------------------------------------------------------

export async function runQuickbooksSync(): Promise<{
  ok: boolean;
  skipped?: string;
  processed?: number;
  synced?: number;
  results?: Array<{ bookingId: string; invoiceId: string | null }>;
  error?: string;
}> {
  if (!quickBooksConfigured()) return { ok: true, skipped: "not_configured" };

  const service = createServiceClient();
  const { data: pending, error } = await service
    .from("invoices")
    .select("booking_id")
    .in("sync_status", ["pending", "error"])
    .eq("status", "paid")
    .limit(25);
  if (error) return { ok: false, error: error.message };

  const results: Array<{ bookingId: string; invoiceId: string | null }> = [];
  for (const row of pending ?? []) {
    const invoiceId = await syncInvoiceForBooking(row.booking_id as string);
    results.push({ bookingId: row.booking_id as string, invoiceId });
  }

  return {
    ok: true,
    processed: results.length,
    synced: results.filter((r) => r.invoiceId).length,
    results,
  };
}
