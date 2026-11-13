import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";

/**
 * A booking's pay-link state for the staff booking page, on the staff
 * member's own session. Staff can't SELECT * on pay_links (column grants,
 * 20261103010000), and these reads never name token_hash or token_encrypted:
 * staff see status, never the link.
 */

/** Exactly the pay_links columns the staff UI reads. Tested against the live grants. */
export const PAY_LINK_STAFF_COLUMNS =
  "id, status, created_by, created_at, ended_at, ended_reason, agreement_ack_at, charge_started_at, paid_at";

export type PayLinkStatus = "active" | "paid" | "superseded" | "ended";

export interface PayLinkSummary {
  id: string;
  status: PayLinkStatus;
  createdAt: string;
  createdByName: string | null;
  endedAt: string | null;
  endedReason: string | null;
  agreementAckAt: string | null;
  chargeStartedAt: string | null;
  paidAt: string | null;
}

export interface PayLinkDelivery {
  type: "pay_link" | "pay_link_reminder";
  channel: "email" | "sms";
  status: "sent" | "failed" | "skipped";
  category: string | null;
  at: string;
  /** Went to a test target instead of the customer. */
  redirected: boolean;
  /**
   * The test variable it went to (a name, never the value). Present only when
   * the log row recorded it (rows from migration 20261112000000 on).
   */
  redirectedVia?: string;
}

const DELIVERY_COLUMNS = "type, channel, delivery_status, failure_category, sent_at, created_at, original_recipient";

/**
 * The column isn't there yet (code deployed before migration 20261112000000):
 * Postgres/PostgREST say 42703 "column notifications_log.redirected_via does
 * not exist". Only this exact case falls back.
 */
function missingRedirectedVia(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204") && (error.message ?? "").includes("redirected_via");
}

export interface PayLinkState {
  active: PayLinkSummary | null;
  /** Newest first, the active one included. */
  links: PayLinkSummary[];
  remindersSent: number;
  lastReminderAt: string | null;
  /** Deliveries of the current link (since it was created), newest first. */
  deliveries: PayLinkDelivery[];
}

export async function getPayLinkState(bookingId: string): Promise<PayLinkState> {
  await assertStaff();
  const supabase = createClient();
  const { data: rows, error } = await supabase
    .from("pay_links")
    .select(PAY_LINK_STAFF_COLUMNS)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`pay_links: ${error.message}`);
  const raw = (rows ?? []) as unknown as Array<Record<string, string | null>>;
  if (raw.length === 0) {
    return { active: null, links: [], remindersSent: 0, lastReminderAt: null, deliveries: [] };
  }

  const creatorIds = Array.from(new Set(raw.map((r) => r.created_by).filter((x): x is string => !!x)));
  const readLog = (columns: string) =>
    supabase
      .from("notifications_log")
      .select(columns)
      .eq("booking_id", bookingId)
      .in("type", ["pay_link", "pay_link_reminder"])
      .order("created_at", { ascending: false })
      .limit(30);
  const [{ data: people }, { data: events, error: evErr }, firstLog] = await Promise.all([
    creatorIds.length
      ? supabase.from("profiles").select("id, full_name").in("id", creatorIds)
      : Promise.resolve({ data: [] as Array<{ id: string; full_name: string | null }> }),
    supabase
      .from("pay_link_events")
      .select("kind, seq, status, yard_date, completed_at")
      .eq("booking_id", bookingId)
      .eq("kind", "customer_reminder"),
    readLog(`${DELIVERY_COLUMNS}, redirected_via`),
  ]);
  // Before the migration the column doesn't exist: read without it, and the
  // page says "the test address" without naming the variable, as it did before.
  const { data: log, error: logErr } = missingRedirectedVia(firstLog.error) ? await readLog(DELIVERY_COLUMNS) : firstLog;
  if (evErr) throw new Error(`pay_link_events: ${evErr.message}`);
  if (logErr) throw new Error(`notifications_log: ${logErr.message}`);

  const names = new Map((people ?? []).map((p) => [p.id as string, (p.full_name as string | null) ?? null]));
  const links: PayLinkSummary[] = raw.map((r) => ({
    id: r.id as string,
    status: r.status as PayLinkStatus,
    createdAt: r.created_at as string,
    createdByName: r.created_by ? names.get(r.created_by) ?? null : null,
    endedAt: r.ended_at,
    endedReason: r.ended_reason,
    agreementAckAt: r.agreement_ack_at,
    chargeStartedAt: r.charge_started_at,
    paidAt: r.paid_at,
  }));
  const active = links.find((l) => l.status === "active") ?? null;
  const current = active ?? links[0];

  const sentReminders = ((events ?? []) as Array<{ status: string; completed_at: string | null }>).filter(
    (e) => e.status === "sent",
  );
  const lastReminderAt =
    sentReminders
      .map((e) => e.completed_at)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;

  const deliveries: PayLinkDelivery[] = ((log ?? []) as unknown as Array<Record<string, string | null>>)
    .filter((d) => (d.created_at as string) >= current.createdAt)
    .map((d) => {
      const redirected = d.original_recipient !== null && d.original_recipient !== undefined;
      return {
        type: d.type as PayLinkDelivery["type"],
        channel: d.channel as PayLinkDelivery["channel"],
        status: d.delivery_status as PayLinkDelivery["status"],
        category: d.failure_category,
        at: (d.sent_at ?? d.created_at) as string,
        redirected,
        ...(redirected && d.redirected_via ? { redirectedVia: d.redirected_via } : {}),
      };
    });

  return { active, links, remindersSent: sentReminders.length, lastReminderAt, deliveries };
}

