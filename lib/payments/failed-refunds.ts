import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";

/**
 * Needs-action: compensating refunds that FAILED (a card was charged, the
 * booking couldn't be made or recorded, and the automatic refund didn't go
 * through). Staff fix it in QuickBooks, then mark it resolved here; the
 * resolve_payment_attempt RPC records who and when. Staff session only.
 */

export interface FailedRefund {
  id: string;
  createdAt: string;
  amount: number | null;
  chargeId: string | null;
  reason: string | null;
  /** Set when the charge belonged to a booking (pay links); online checkout failures have none. */
  bookingId: string | null;
  /** "online checkout" or "pay link". */
  source: "pay_link" | "checkout";
}

export async function listFailedRefunds(): Promise<FailedRefund[]> {
  await assertStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("payment_attempts")
    .select("id, created_at, amount, qb_charge_id, reason, context")
    .eq("kind", "compensating_refund")
    .is("resolved_at", null)
    .eq("context->>refund_succeeded", "false")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`payment_attempts: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const ctx = (r.context ?? {}) as Record<string, unknown>;
    const bookingId = typeof ctx.booking_id === "string" ? ctx.booking_id : null;
    return {
      id: r.id as string,
      createdAt: r.created_at as string,
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
      chargeId: (r.qb_charge_id as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      bookingId,
      source: bookingId ? "pay_link" : "checkout",
    };
  });
}

export class ResolveError extends Error {}

export async function resolveFailedRefund(id: string): Promise<void> {
  await assertStaff();
  const supabase = createClient();
  const { error } = await supabase.rpc("resolve_payment_attempt", { p_attempt_id: id });
  if (error) {
    if (error.code === "P0002") throw new ResolveError("Already resolved (or not found) — refresh the page.");
    if (error.code === "42501") throw new ResolveError("You do not have permission to do that.");
    throw new ResolveError(error.message);
  }
}
