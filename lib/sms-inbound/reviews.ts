import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";

/**
 * Needs-action: inbound texts that need a person (Plan B.4).
 *
 *   cancel_keyword       the customer texted CANCEL. Texts to them have already
 *                        stopped; staff check whether a booking cancel was meant.
 *   keyword_in_message   an opt-out word inside a longer message. Texts to that
 *                        number are BLOCKED until staff treat it as a STOP or
 *                        say it isn't one.
 *
 * Staff session only. resolve_sms_review records who and when. The message
 * text is kept 30 days after it's resolved (purge_sms_review_text, daily cron).
 */

export const SMS_REVIEW_TEXT_RETENTION_DAYS = 30;

export type SmsReviewReason = "cancel_keyword" | "keyword_in_message";
export type SmsReviewOutcome = "checked" | "treated_as_stop" | "not_a_stop";

export interface SmsReview {
  id: string;
  reason: SmsReviewReason;
  keyword: string;
  /** keyword_in_message only: the text (card numbers redacted). */
  text: string | null;
  receivedAt: string;
  customers: Array<{ id: string; name: string }>;
  /** Last four digits, only when no customer has this number. */
  numberHint: string | null;
}

/** Table not there yet (code deployed before migration 20261113000000). */
function tableMissing(error: { code?: string; message?: string }): boolean {
  return (error.code === "42P01" || error.code === "PGRST205") && (error.message ?? "").includes("sms_inbound_events");
}

/**
 * Open reviews, oldest first. null = they couldn't be read (the dashboard says
 * so); [] before the migration, when there can't be any.
 */
export async function listOpenSmsReviews(): Promise<SmsReview[] | null> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("sms_inbound_events")
    .select("id, keyword, review_reason, review_text, received_at, customer_ids, phone_key")
    .eq("needs_review", true)
    .is("reviewed_at", null)
    .order("received_at", { ascending: true })
    .limit(25);
  if (error) {
    if (tableMissing(error)) return [];
    console.error("[sms-reviews] read failed:", error.code ?? "unknown");
    return null;
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = Array.from(new Set(rows.flatMap((r) => (Array.isArray(r.customer_ids) ? (r.customer_ids as string[]) : []))));
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await supabase.from("customers").select("id, full_name").in("id", ids);
    for (const p of (people ?? []) as Array<{ id: string; full_name: string | null }>) names.set(p.id, p.full_name ?? "Customer");
  }
  return rows.map((r) => {
    const customerIds = Array.isArray(r.customer_ids) ? (r.customer_ids as string[]) : [];
    const key = typeof r.phone_key === "string" ? r.phone_key : null;
    return {
      id: r.id as string,
      reason: r.review_reason as SmsReviewReason,
      keyword: r.keyword as string,
      text: (r.review_text as string | null) ?? null,
      receivedAt: r.received_at as string,
      customers: customerIds.map((id) => ({ id, name: names.get(id) ?? "Customer" })),
      numberHint: customerIds.length === 0 && key ? key.slice(-4) : null,
    };
  });
}

export class SmsReviewError extends Error {}

/** Allowed outcomes per reason; the database enforces the same. */
export function outcomeAllowed(reason: SmsReviewReason, outcome: string): outcome is SmsReviewOutcome {
  return reason === "cancel_keyword" ? outcome === "checked" : outcome === "treated_as_stop" || outcome === "not_a_stop";
}

export async function resolveSmsReview(id: string, outcome: SmsReviewOutcome): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("resolve_sms_review", { p_event_id: id, p_outcome: outcome });
  if (error) {
    if (error.code === "42501") throw new SmsReviewError("You do not have permission to do that.");
    if (error.code === "22023") {
      throw new SmsReviewError(
        error.hint === "already_resolved"
          ? "Someone already checked this text — refresh the page."
          : "This text can't be resolved that way — refresh the page.",
      );
    }
    throw new SmsReviewError("Something went wrong. Refresh and try again.");
  }
}

// --- daily purge of resolved review text ----------------------------------

export type SmsPurgeRpc = (
  name: "purge_sms_review_text",
  args: { p_days: number },
) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

export interface SmsPurgeResult {
  ok: boolean;
  retention_days: number;
  purged: number;
  /** The function isn't there yet (migration 20261113000000 not applied). */
  skipped?: "not_applied";
  error?: string;
}

/**
 * Blanks review text resolved more than 30 days ago. No flag: it only removes
 * text staff have finished with. Never throws; errors come back as codes only.
 */
export async function runSmsReviewPurge(rpc: SmsPurgeRpc): Promise<SmsPurgeResult> {
  const out: SmsPurgeResult = { ok: true, retention_days: SMS_REVIEW_TEXT_RETENTION_DAYS, purged: 0 };
  try {
    const { data, error } = await rpc("purge_sms_review_text", { p_days: SMS_REVIEW_TEXT_RETENTION_DAYS });
    if (error) {
      if ((error.code === "PGRST202" || error.code === "42883") && (error.message ?? "").includes("purge_sms_review_text")) {
        return { ...out, skipped: "not_applied" };
      }
      return { ...out, ok: false, error: `purge_failed ${error.code ?? "unknown"}` };
    }
    if (typeof data !== "number" || !Number.isInteger(data) || data < 0) return { ...out, ok: false, error: "purge_bad_result" };
    return { ...out, purged: data };
  } catch {
    return { ...out, ok: false, error: "purge_failed network" };
  }
}
