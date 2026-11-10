import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import {
  notifyOverdue,
  notifyDeliveryReminder,
  notifyPickupReminder,
  notifyStaffUnpaidAlert,
  notifyPayLink,
  alreadyNotified,
} from "@/lib/notifications/notify";
import { payLinkTokenKey } from "@/lib/pay-links/token";
import { getValidAccessToken } from "@/lib/quickbooks/tokens";
import { yardToday, yardTomorrow } from "@/lib/time/yard";
import { syncInvoiceForBooking } from "@/lib/quickbooks/invoices";
import {
  reconcileInvoicePayments,
  type ReconcileResult,
} from "@/lib/quickbooks/invoice-payments";
import { quickBooksConfigured, missingQuickBooksEnv } from "@/lib/quickbooks/config";
import { runTranscriptPurge, type PurgeResult } from "@/lib/call-log/purge";

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
  const tomorrow = yardTomorrow();

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

// --- pay links ----------------------------------------------------------
//
// pay_link_due_events (yard day) says what is due; claim_pay_link_event
// inserts the ledger row BEFORE anything is sent, so a re-run of the cron
// finds the row and sends nothing. With the feature off nothing is due, but
// the lookup rate-limit rows are still purged.
//
// Customer reminders resend the SAME live link, decrypted from
// pay_links.token_encrypted with CL_PAY_LINK_TOKEN_KEY. The token is fetched
// before the claim, so a reminder is claimed only when it can be sent.
// Without the key, or for a link with no stored copy (issued before the key
// existed; staff fix it with Resend), the reminder is left unclaimed, counted
// under not_sent, and the job reports ok:false so the daily cron result shows it.

type ReminderNotSent = "no_key" | "no_stored_token" | "decrypt_failed" | "no_link" | "error";

export async function runPayLinks(): Promise<{
  ok: boolean;
  enabled: boolean;
  date: string;
  purged_lookup_rows: number;
  customer_reminders: { sent: number; already_claimed: number; not_sent: Record<ReminderNotSent, number> };
  staff_alerts: { sent: number; already_claimed: number; no_recipients: number };
  errors: string[];
}> {
  const service = createServiceClient();
  const today = yardToday();
  const notSent: Record<ReminderNotSent, number> = { no_key: 0, no_stored_token: 0, decrypt_failed: 0, no_link: 0, error: 0 };
  const out = {
    ok: true,
    enabled: false,
    date: today,
    purged_lookup_rows: 0,
    customer_reminders: { sent: 0, already_claimed: 0, not_sent: notSent },
    staff_alerts: { sent: 0, already_claimed: 0, no_recipients: 0 },
    errors: [] as string[],
  };

  const purged = await service.rpc("purge_pay_link_lookup_attempts");
  if (purged.error) out.errors.push(`purge: ${purged.error.message}`);
  else out.purged_lookup_rows = Number(purged.data ?? 0);

  const { data: settings, error: sErr } = await service
    .from("cl_pay_link_settings")
    .select("enabled, staff_alert_each_reminder")
    .eq("id", true)
    .maybeSingle();
  if (sErr) throw new Error(`cl_pay_link_settings: ${sErr.message}`);
  out.enabled = settings?.enabled === true;
  if (!out.enabled) {
    out.ok = out.errors.length === 0;
    return out;
  }
  const alertEachReminder = settings?.staff_alert_each_reminder === true;

  const { data: due, error: dErr } = await service.rpc("pay_link_due_events", { p_today: today });
  if (dErr) throw new Error(`pay_link_due_events: ${dErr.message}`);
  const rows = (due ?? []) as Array<{ booking_id: string; kind: string; seq: number }>;

  /** true = this run owns the send; false = already claimed; null = error (logged). */
  const claim = async (bookingId: string, kind: string, seq: number): Promise<boolean | null> => {
    const { data, error } = await service.rpc("claim_pay_link_event", {
      p_booking_id: bookingId, p_kind: kind, p_seq: seq, p_yard_date: today,
    });
    if (error) {
      out.errors.push(`claim ${kind} ${bookingId}: ${error.message}`);
      return null;
    }
    return data === true;
  };
  const finish = (bookingId: string, kind: string, seq: number, status: "sent" | "failed", detail: string) =>
    service.rpc("finish_pay_link_event", {
      p_booking_id: bookingId, p_kind: kind, p_seq: seq, p_status: status, p_detail: detail,
    });

  let recipients: Array<{ email: string }> | null = null;
  const getRecipients = async (): Promise<Array<{ email: string }>> => {
    if (recipients === null) {
      const { data: r, error: rErr } = await service.rpc("pay_link_staff_alert_recipients");
      if (rErr) out.errors.push(`recipients: ${rErr.message}`);
      recipients = ((r ?? []) as Array<{ email: string }>).filter((x) => !!x.email);
    }
    return recipients;
  };
  const sendStaffAlert = async (
    bookingId: string,
    kind: "staff_alert" | "staff_alert_on_reminder",
    seq: number,
    remindersSent: number,
  ) => {
    const claimed = await claim(bookingId, kind, seq);
    if (claimed === null) return;
    if (!claimed) {
      out.staff_alerts.already_claimed++;
      return;
    }
    const to = await getRecipients();
    if (to.length === 0) {
      out.staff_alerts.no_recipients++;
      await finish(bookingId, kind, seq, "failed", "no active staff or owner with an email");
      return;
    }
    await notifyStaffUnpaidAlert({
      bookingId,
      recipients: to,
      reason: kind === "staff_alert" ? "after_days" : "reminder_sent",
      remindersSent,
      today,
    });
    await finish(bookingId, kind, seq, "sent", `${to.length} recipient(s); per-channel results in notifications_log`);
    out.staff_alerts.sent++;
  };

  const key = payLinkTokenKey();
  for (const row of rows) {
    if (row.kind === "staff_alert") {
      const { count } = await service
        .from("pay_link_events")
        .select("id", { count: "exact", head: true })
        .eq("booking_id", row.booking_id)
        .eq("kind", "customer_reminder")
        .eq("status", "sent");
      await sendStaffAlert(row.booking_id, "staff_alert", row.seq, count ?? 0);
      continue;
    }
    if (row.kind !== "customer_reminder") continue;

    if (!key) {
      notSent.no_key++;
      continue;
    }
    const { data: got, error: tErr } = await service.rpc("pay_link_reminder_token", {
      p_booking_id: row.booking_id,
      p_key: key,
    });
    if (tErr) out.errors.push(`reminder token ${row.booking_id}: ${tErr.message}`);
    const state = tErr ? "error" : String((got as { state?: string } | null)?.state ?? "error");
    if (state !== "ok") {
      notSent[(state in notSent ? state : "error") as ReminderNotSent]++;
      continue;
    }
    const token = String((got as { token: string }).token);

    const claimed = await claim(row.booking_id, "customer_reminder", row.seq);
    if (claimed === null) continue;
    if (!claimed) {
      out.customer_reminders.already_claimed++;
      continue;
    }
    await notifyPayLink(row.booking_id, token, "pay_link_reminder");
    await finish(row.booking_id, "customer_reminder", row.seq, "sent", "per-channel results in notifications_log");
    out.customer_reminders.sent++;

    if (alertEachReminder) {
      await sendStaffAlert(row.booking_id, "staff_alert_on_reminder", row.seq, row.seq);
    }
  }

  if (notSent.no_key > 0) {
    out.errors.push(`CL_PAY_LINK_TOKEN_KEY is not set (or under 32 characters): ${notSent.no_key} customer reminder(s) not sent`);
  }
  if (notSent.no_stored_token > 0) {
    out.errors.push(`${notSent.no_stored_token} customer reminder(s) not sent: the link has no stored copy — staff can Resend it`);
  }
  if (notSent.decrypt_failed > 0) {
    out.errors.push(`${notSent.decrypt_failed} customer reminder(s) not sent: the stored link didn't decrypt with CL_PAY_LINK_TOKEN_KEY (key changed?)`);
  }
  out.ok = out.errors.length === 0;
  return out;
}

// --- quickbooks-refresh -------------------------------------------------

export async function runQuickbooksRefresh(): Promise<{
  ok: boolean;
  refreshed?: boolean;
  skipped?: string;
  error?: string;
}> {
  if (!quickBooksConfigured()) {
    // Silently skipping "not configured" is correct when QuickBooks was never
    // set up — but if the connection row says a real connection already
    // exists, "env vars vanished out from under a live connection" is a
    // genuine regression, not a no-op. This is exactly the failure mode that
    // let production sit unrefreshed for 4 days (2026-09-15) with every daily
    // cron run reporting ok:true the whole time — surface it as a real
    // failure instead.
    try {
      const service = createServiceClient();
      const { data } = await service
        .from("quickbooks_connection")
        .select("status")
        .eq("id", true)
        .maybeSingle();
      if (data?.status === "connected") {
        return {
          ok: false,
          error:
            `quickbooks_connection.status is 'connected' but these env vars are missing/empty: ${missingQuickBooksEnv().join(", ")}. A live connection can't be kept alive — check Vercel Production env vars.`,
        };
      }
    } catch {
      /* fall through to the normal skip below if even this check fails */
    }
    return { ok: true, skipped: "not_configured" };
  }

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
  invoicePayments?: ReconcileResult | { error: string };
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

  // Pay-link invoices on staff-created bookings: did the customer pay?
  // Polling Invoice.Balance once a day (plus the staff "Check payment now"
  // button) instead of a QBO webhook — Intuit's own guidance says webhooks
  // can miss events and need a daily reconcile anyway; this IS that
  // reconcile. Its own try/catch so a poll failure never hides the sync above.
  let invoicePayments: ReconcileResult | { error: string };
  try {
    invoicePayments = await reconcileInvoicePayments();
  } catch (e) {
    invoicePayments = { error: (e as Error).message };
  }

  return {
    ok: !("error" in invoicePayments),
    processed: results.length,
    synced: results.filter((r) => r.invoiceId).length,
    results,
    invoicePayments,
  };
}

// --- call transcript purge ------------------------------------------------
//
// Off unless CL_CALL_TRANSCRIPT_PURGE_ENABLED=1 (lib/call-log/purge.ts). Blanks
// transcript text older than TRANSCRIPT_RETENTION_DAYS; never throws.

export async function runCallTranscriptPurge(): Promise<PurgeResult> {
  const service = createServiceClient();
  return runTranscriptPurge(async (name, args) => {
    const { data, error } = await service.rpc(name, args);
    return { data, error };
  });
}
