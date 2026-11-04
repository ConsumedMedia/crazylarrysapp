import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { sendSms, type SendResult } from "./sms";
import { sendEmail } from "./email";
import { toE164US } from "./phone";
import * as T from "./templates";
import { payLinkUrl, redactPayLinks, siteUrl } from "@/lib/pay-links/token";
import { yardDateOf } from "@/lib/time/yard";

/**
 * Notification orchestrator. Every export here is guaranteed not to throw —
 * a failed or skipped send is written to notifications_log and swallowed, so
 * the booking / job / cron operation it hangs off of always completes.
 *
 * Reads recipient data with the service-role client (guest bookings have no
 * session; notifications_log + customers + drivers are staff-only under RLS).
 */

type Channel = "email" | "sms";

/** What happened on one channel. Deliberately carries no recipient or text. */
export interface ChannelOutcome {
  channel: Channel;
  status: "sent" | "failed" | "skipped";
  category: string | null;
  /** CL_NOTIFICATIONS_TEST_TO sent it to the test address instead. */
  redirected: boolean;
}

interface LogRow {
  booking_id: string | null;
  driver_id: string | null;
  type: string;
  channel: Channel;
  /** Who was actually sent to (the test address when redirected). */
  recipient: string;
  /** The intended recipient, set only when CL_NOTIFICATIONS_TEST_TO redirected the send. */
  original_recipient: string | null;
  delivery_status: "sent" | "failed" | "skipped";
  sent_at: string | null;
  body: string;
  error: string | null;
  provider_message_id: string | null;
  failure_category: string | null;
}

async function writeLog(row: LogRow): Promise<void> {
  // A working pay link must never sit in the log (staff-readable, kept forever).
  row = { ...row, body: redactPayLinks(row.body), error: redactPayLinks(row.error) };
  try {
    const service = createServiceClient();
    // supabase-js reports insert failures in the result, not by throwing —
    // without this check a rejected row (e.g. a column the DB doesn't have
    // yet) vanishes without a trace.
    const { error } = await service.from("notifications_log").insert(row);
    if (error) console.error("[notify] notifications_log insert failed:", error.message);
  } catch (e) {
    // Logging the log failure is all we can safely do.
    console.error("[notify] notifications_log insert failed:", (e as Error).message);
  }
}

function logRowFrom(
  base: { type: string; bookingId: string | null; driverId: string | null },
  channel: Channel,
  recipient: string,
  body: string,
  result: SendResult,
): LogRow {
  return {
    booking_id: base.bookingId,
    driver_id: base.driverId,
    type: base.type,
    channel,
    recipient: result.sentTo ?? recipient,
    original_recipient: result.redirected ? recipient : null,
    delivery_status: result.ok ? "sent" : result.skipped ? "skipped" : "failed",
    sent_at: result.ok ? new Date().toISOString() : null,
    body,
    error: result.ok ? null : (result.error ?? "unknown error"),
    provider_message_id: result.providerMessageId ?? null,
    failure_category: result.ok ? null : (result.category ?? null),
  };
}

/**
 * Fan out to the requested channels, log every outcome, never throw. Returns
 * what happened on each channel (no recipients, no message text), for callers
 * that show staff what went out.
 */
async function dispatch(opts: {
  type: string;
  bookingId: string | null;
  driverId: string | null;
  rendered: T.Rendered;
  email: string | null;
  phone: string | null;
  smsConsent: boolean;
  channels: Channel[];
}): Promise<ChannelOutcome[]> {
  const base = { type: opts.type, bookingId: opts.bookingId, driverId: opts.driverId };
  const jobs: Promise<void>[] = [];
  const outcomes: ChannelOutcome[] = [];
  const log = (row: LogRow) => {
    outcomes.push({
      channel: row.channel,
      status: row.delivery_status,
      category: row.failure_category,
      redirected: row.original_recipient !== null,
    });
    return writeLog(row);
  };

  if (opts.channels.includes("sms")) {
    if (!opts.smsConsent) {
      jobs.push(
        log(
          logRowFrom(base, "sms", opts.phone ?? "(none)", opts.rendered.sms, {
            ok: false,
            skipped: true,
            category: "no_consent",
            error: "customer has not consented to SMS",
          }),
        ),
      );
    } else {
      const e164 = toE164US(opts.phone);
      if (!e164) {
        jobs.push(
          log(
            logRowFrom(base, "sms", opts.phone ?? "(none)", opts.rendered.sms, {
              ok: false,
              category: "recipient_missing",
              error: opts.phone ? `unparseable phone: ${opts.phone}` : "no phone on file",
            }),
          ),
        );
      } else {
        jobs.push(
          sendSms(e164, opts.rendered.sms).then((r) =>
            log(logRowFrom(base, "sms", e164, opts.rendered.sms, r)),
          ),
        );
      }
    }
  }

  if (opts.channels.includes("email")) {
    if (!opts.email) {
      jobs.push(
        log(
          logRowFrom(base, "email", "(none)", opts.rendered.email.text, {
            ok: false,
            category: "recipient_missing",
            error: "no email on file",
          }),
        ),
      );
    } else {
      jobs.push(
        sendEmail({
          to: opts.email,
          subject: opts.rendered.email.subject,
          text: opts.rendered.email.text,
          html: opts.rendered.email.html,
        }).then((r) =>
          log(logRowFrom(base, "email", opts.email as string, opts.rendered.email.text, r)),
        ),
      );
    }
  }

  await Promise.allSettled(jobs);
  return outcomes;
}

// --- data loaders --------------------------------------------------------

interface BookingBundle {
  id: string;
  size_requested: string;
  delivery_date: string;
  pickup_date: string | null;
  delivery_address: string;
  placement_notes: string | null;
  total: number;
  payment_status: string;
  customer: {
    full_name: string;
    email: string | null;
    phone: string | null;
    sms_consent: boolean;
  } | null;
}

async function loadBooking(bookingId: string): Promise<BookingBundle | null> {
  const service = createServiceClient();
  const { data } = await service
    .from("bookings")
    .select(
      "id, size_requested, delivery_date, pickup_date, delivery_address, placement_notes, total, payment_status, customers(full_name, email, phone, sms_consent)",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (!data) return null;
  const d = data as Record<string, unknown>;
  const c = d.customers as
    | { full_name: string; email: string | null; phone: string | null; sms_consent: boolean }
    | null;
  return {
    id: d.id as string,
    size_requested: d.size_requested as string,
    delivery_date: d.delivery_date as string,
    pickup_date: (d.pickup_date as string | null) ?? null,
    delivery_address: d.delivery_address as string,
    placement_notes: (d.placement_notes as string | null) ?? null,
    total: Number(d.total),
    payment_status: d.payment_status as string,
    customer: c,
  };
}

function bookingCtx(b: BookingBundle): T.BookingCtx {
  return {
    contactName: b.customer?.full_name ?? "there",
    size: b.size_requested,
    deliveryDate: b.delivery_date,
    pickupDate: b.pickup_date ?? b.delivery_date,
    address: b.delivery_address,
    total: b.total,
    paid: b.payment_status === "paid",
  };
}

// --- public entry points ----------------------------------------------

export async function notifyBookingConfirmation(bookingId: string): Promise<void> {
  try {
    const b = await loadBooking(bookingId);
    if (!b) return;
    await dispatch({
      type: "booking_confirmation",
      bookingId,
      driverId: null,
      rendered: T.bookingConfirmation(bookingCtx(b)),
      email: b.customer?.email ?? null,
      phone: b.customer?.phone ?? null,
      smsConsent: b.customer?.sms_consent ?? false,
      channels: ["email", "sms"],
    });
  } catch (e) {
    console.error("[notify] booking_confirmation:", (e as Error).message);
  }
}

export async function notifyDeliveryReminder(bookingId: string): Promise<void> {
  try {
    const b = await loadBooking(bookingId);
    if (!b) return;
    await dispatch({
      type: "delivery_reminder",
      bookingId,
      driverId: null,
      rendered: T.deliveryReminder(bookingCtx(b)),
      email: b.customer?.email ?? null,
      phone: b.customer?.phone ?? null,
      smsConsent: b.customer?.sms_consent ?? false,
      channels: ["email", "sms"],
    });
  } catch (e) {
    console.error("[notify] delivery_reminder:", (e as Error).message);
  }
}

export async function notifyPickupReminder(bookingId: string): Promise<void> {
  try {
    const b = await loadBooking(bookingId);
    if (!b) return;
    await dispatch({
      type: "pickup_reminder",
      bookingId,
      driverId: null,
      rendered: T.pickupReminder(bookingCtx(b)),
      email: b.customer?.email ?? null,
      phone: b.customer?.phone ?? null,
      smsConsent: b.customer?.sms_consent ?? false,
      channels: ["email", "sms"],
    });
  } catch (e) {
    console.error("[notify] pickup_reminder:", (e as Error).message);
  }
}

export async function notifyOverdue(bookingId: string): Promise<void> {
  try {
    const b = await loadBooking(bookingId);
    if (!b) return;
    await dispatch({
      type: "overdue_notice",
      bookingId,
      driverId: null,
      rendered: T.overdueNotice(bookingCtx(b)),
      email: b.customer?.email ?? null,
      phone: b.customer?.phone ?? null,
      smsConsent: b.customer?.sms_consent ?? false,
      channels: ["email", "sms"],
    });
  } catch (e) {
    console.error("[notify] overdue_notice:", (e as Error).message);
  }
}

/** delivery_complete / pickup_complete — SMS only, per spec. */
export async function notifyJobComplete(job: {
  id: string;
  type: "delivery" | "pickup";
  booking_id: string;
}): Promise<void> {
  try {
    const b = await loadBooking(job.booking_id);
    if (!b) return;
    const rendered =
      job.type === "delivery"
        ? T.deliveryComplete({
            contactName: b.customer?.full_name ?? "there",
            size: b.size_requested,
            address: b.delivery_address,
            pickupDate: b.pickup_date ?? b.delivery_date,
          })
        : T.pickupComplete({
            contactName: b.customer?.full_name ?? "there",
            size: b.size_requested,
            address: b.delivery_address,
          });
    await dispatch({
      type: job.type === "delivery" ? "delivery_complete" : "pickup_complete",
      bookingId: job.booking_id,
      driverId: null,
      rendered,
      email: b.customer?.email ?? null,
      phone: b.customer?.phone ?? null,
      smsConsent: b.customer?.sms_consent ?? false,
      channels: ["sms"],
    });
  } catch (e) {
    console.error("[notify] job_complete:", (e as Error).message);
  }
}

/** job_assigned — SMS to the driver. */
export async function notifyJobAssigned(
  jobId: string,
  driverId: string,
): Promise<void> {
  try {
    const service = createServiceClient();
    const [{ data: job }, { data: driver }] = await Promise.all([
      service
        .from("jobs")
        .select("id, type, scheduled_date, booking_id")
        .eq("id", jobId)
        .maybeSingle(),
      service
        .from("drivers")
        .select("full_name, phone")
        .eq("id", driverId)
        .maybeSingle(),
    ]);
    if (!job) return;
    const b = await loadBooking((job as { booking_id: string }).booking_id);
    if (!b) return;
    const j = job as { type: "delivery" | "pickup"; scheduled_date: string };
    await dispatch({
      type: "job_assigned",
      bookingId: b.id,
      driverId,
      rendered: T.jobAssigned({
        driverName: (driver as { full_name?: string } | null)?.full_name ?? "Driver",
        jobType: j.type,
        size: b.size_requested,
        address: b.delivery_address,
        scheduledDate: j.scheduled_date,
        placementNotes: b.placement_notes,
      }),
      email: null,
      phone: (driver as { phone?: string | null } | null)?.phone ?? null,
      // Driver notification, not a customer one — customer sms_consent doesn't apply.
      smsConsent: true,
      channels: ["sms"],
    });
  } catch (e) {
    console.error("[notify] job_assigned:", (e as Error).message);
  }
}

/**
 * The pay link (first send, resend or reminder). Email whenever there is an
 * address; SMS only with consent (dispatch logs the skip otherwise). With no
 * email on file the email channel isn't attempted at all — the contact rule
 * guaranteed a consented phone instead. The token reaches the providers but
 * never notifications_log (writeLog redacts it).
 */
export async function notifyPayLink(
  bookingId: string,
  token: string,
  type: "pay_link" | "pay_link_reminder",
): Promise<ChannelOutcome[]> {
  try {
    const b = await loadBooking(bookingId);
    if (!b) return [];
    const ctx = { ...bookingCtx(b), url: payLinkUrl(token) };
    const email = b.customer?.email ?? null;
    return await dispatch({
      type,
      bookingId,
      driverId: null,
      rendered: type === "pay_link" ? T.payLink(ctx) : T.payLinkReminder(ctx),
      email,
      phone: b.customer?.phone ?? null,
      smsConsent: b.customer?.sms_consent ?? false,
      channels: email ? ["email", "sms"] : ["sms"],
    });
  } catch (e) {
    console.error(`[notify] ${type}:`, redactPayLinks((e as Error).message));
    return [];
  }
}

/** Unpaid-booking alert — email only, one log row per staff recipient. */
export async function notifyStaffUnpaidAlert(opts: {
  bookingId: string;
  recipients: Array<{ email: string }>;
  reason: "after_days" | "reminder_sent";
  remindersSent: number;
  today: string;
}): Promise<void> {
  try {
    const service = createServiceClient();
    const { data } = await service
      .from("bookings")
      .select("id, size_requested, delivery_date, total, created_at, customers(full_name, phone)")
      .eq("id", opts.bookingId)
      .maybeSingle();
    if (!data) return;
    const d = data as Record<string, unknown>;
    const c = d.customers as { full_name: string; phone: string | null } | null;
    const made = yardDateOf(String(d.created_at));
    const daysUnpaid = Math.round(
      (Date.parse(`${opts.today}T00:00:00Z`) - Date.parse(`${made}T00:00:00Z`)) / 86_400_000,
    );
    const rendered = T.staffUnpaidAlert({
      contactName: c?.full_name ?? "Customer",
      phone: c?.phone ?? null,
      size: d.size_requested as string,
      deliveryDate: d.delivery_date as string,
      total: Number(d.total),
      daysUnpaid,
      remindersSent: opts.remindersSent,
      bookingUrl: `${siteUrl()}/bookings/${opts.bookingId}`,
      reason: opts.reason,
    });
    await Promise.allSettled(
      opts.recipients.map((r) =>
        dispatch({
          type: "staff_unpaid_alert",
          bookingId: opts.bookingId,
          driverId: null,
          rendered,
          email: r.email,
          phone: null,
          smsConsent: false,
          channels: ["email"],
        }),
      ),
    );
  } catch (e) {
    console.error("[notify] staff_unpaid_alert:", (e as Error).message);
  }
}

/**
 * True if a notification of this type for this booking was already logged
 * within `withinHours` (any delivery_status). Used by the reminder cron so a
 * re-run doesn't double-send.
 */
export async function alreadyNotified(
  bookingId: string,
  type: string,
  withinHours = 48,
): Promise<boolean> {
  try {
    const service = createServiceClient();
    const since = new Date(Date.now() - withinHours * 3600_000).toISOString();
    const { count } = await service
      .from("notifications_log")
      .select("id", { count: "exact", head: true })
      .eq("booking_id", bookingId)
      .eq("type", type)
      .gte("created_at", since);
    return (count ?? 0) > 0;
  } catch {
    return false; // fail open — better a possible dup than a missed reminder
  }
}
