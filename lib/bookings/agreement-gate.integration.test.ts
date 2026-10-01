/**
 * Integration test — the online checkout refuses to charge unless the DocuSign
 * rental agreement is server-verified. Runs the REAL payAndBook against the
 * linked Supabase project; the QuickBooks charge/refund functions are replaced
 * by spies so the test can prove no charge was ever attempted (and no real
 * money/QBO sandbox call happens). QBO invoice sync and notifications are
 * stubbed too. DB writes only -> gated by CL_RUN_DB_TESTS=1.
 *
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/bookings/agreement-gate.integration.test.ts
 *
 * Agreement sessions are inserted directly (service role) in the states under
 * test — DocuSign's own verification is covered by the sandbox test + the
 * manual signing step. Cleanup: every created session / booking / customer is
 * tracked and deleted independently.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const RUN = process.env.CL_RUN_DB_TESTS === "1";

const createCharge = vi.fn(async () => ({
  chargeId: `TEST-CHARGE-${Date.now()}`,
  status: "CAPTURED",
  authCode: null,
  cardType: null,
  cardNumberMasked: null,
}));
const refundCharge = vi.fn(async () => ({ refundId: "TEST-REFUND", status: "ISSUED", kind: "void" as const, rawType: "VOID" }));
vi.mock("@/lib/quickbooks/payments", () => ({
  createCharge,
  refundCharge,
  PaymentError: class PaymentError extends Error {},
}));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn(async () => null) }));
vi.mock("@/lib/notifications/notify", () => ({ notifyBookingConfirmation: vi.fn(async () => undefined) }));

const MARKER = `__agreement_gate_test__${Date.now()}`;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function input(email: string, offsetDays: number) {
  const d = new Date(Date.UTC(2027, 10, 1) + offsetDays * 86_400_000).toISOString().slice(0, 10);
  return {
    size: "10yd" as const,
    deliveryDate: d,
    rentalDays: 5,
    street: `1 ${MARKER} St`,
    city: "Columbus",
    state: "OH",
    zip: "43004",
    contactName: "ZZ Agreement Gate Test",
    contactEmail: email,
  };
}
const PAYMENT = { token: "test-token-never-charged", idempotencyKey: "test-idem" };

describe.skipIf(!RUN)("checkout agreement gate — refuses before any card charge", () => {
  let service: SupabaseClient;
  let payAndBook: typeof import("./checkout").payAndBook;
  const sessionIds: string[] = [];
  const bookingIds: string[] = [];

  async function session(status: "sent" | "completed", email: string): Promise<string> {
    const { data, error } = await service
      .from("agreement_sessions")
      .insert({
        envelope_id: `TEST-ENV-${MARKER}-${sessionIds.length}`,
        signer_name: "ZZ Agreement Gate Test",
        signer_email: email.toLowerCase(),
        status,
        completed_at: status === "completed" ? new Date().toISOString() : null,
        verified_at: status === "completed" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`fixture session: ${error.message}`);
    sessionIds.push(data!.id);
    return data!.id as string;
  }

  beforeAll(async () => {
    service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    ({ payAndBook } = await import("./checkout"));
  });
  beforeEach(() => {
    createCharge.mockClear();
    refundCharge.mockClear();
  });

  afterAll(async () => {
    if (!service) return;
    // bookings created by the happy path (found by marker, not just tracked ids)
    const { data: made } = await service.from("bookings").select("id, customer_id").like("delivery_address", `%${MARKER}%`);
    for (const b of made ?? []) bookingIds.push(b.id as string);
    const customerIds = new Set((made ?? []).map((b) => b.customer_id as string));
    for (const id of sessionIds) {
      try { await service.from("agreement_sessions").delete().eq("id", id); } catch (e) { console.error("[cleanup] session", (e as Error).message); }
    }
    for (const id of Array.from(new Set(bookingIds))) {
      const { data: jobs } = await service.from("jobs").select("id").eq("booking_id", id);
      for (const step of [
        () => service.from("status_log").delete().in("entity_id", [id, ...(jobs ?? []).map((j) => j.id as string)]),
        () => service.from("invoices").delete().eq("booking_id", id),
        () => service.from("notifications_log").delete().eq("booking_id", id),
        () => service.from("jobs").delete().eq("booking_id", id),
        () => service.from("bookings").delete().eq("id", id),
      ]) {
        try { const { error } = await step(); if (error) console.error("[cleanup]", error.message); } catch (e) { console.error("[cleanup]", (e as Error).message); }
      }
    }
    for (const id of Array.from(customerIds)) {
      try { await service.from("customers").delete().eq("id", id); } catch (e) { console.error("[cleanup] customer", (e as Error).message); }
    }
  });

  it("1. no agreement session -> refused, no charge", async () => {
    const r = await payAndBook(input("gate-a@example.com", 0), PAYMENT, null);
    console.log("no session           ->", r.code, "|", r.error, "| createCharge calls:", createCharge.mock.calls.length);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("agreement_missing");
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("2. unsigned session (envelope sent, not completed) -> refused, no charge", async () => {
    const s = await session("sent", "gate-b@example.com");
    const r = await payAndBook(input("gate-b@example.com", 0), PAYMENT, s);
    console.log("unsigned session     ->", r.code, "|", r.error, "| createCharge calls:", createCharge.mock.calls.length);
    expect(r.code).toBe("agreement_incomplete");
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("3. completed session used with a different email -> refused, no charge", async () => {
    const s = await session("completed", "gate-signer@example.com");
    const r = await payAndBook(input("someone-else@example.com", 0), PAYMENT, s);
    console.log("email mismatch       ->", r.code, "|", r.error, "| createCharge calls:", createCharge.mock.calls.length);
    expect(r.code).toBe("agreement_email_mismatch");
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("4. completed session: first checkout books + consumes it; reusing it is refused, no second charge", async () => {
    const s = await session("completed", "gate-d@example.com");
    const first = await payAndBook(input("Gate-D@Example.com", 20), PAYMENT, s);
    const { data: b } = await service
      .from("bookings")
      .select("id, docusign_status, docusign_envelope_id, docusign_completed_at")
      .eq("id", first.bookingId ?? "00000000-0000-0000-0000-000000000000")
      .maybeSingle();
    const { data: sess } = await service.from("agreement_sessions").select("consumed_booking_id, consumed_at").eq("id", s).single();
    console.log("valid session        ->", first.ok ? "BOOKED" : first.code, "| booking:", JSON.stringify(b), "| session consumed by it:", sess?.consumed_booking_id === first.bookingId, "| createCharge calls:", createCharge.mock.calls.length);
    expect(first.ok).toBe(true);
    expect(createCharge).toHaveBeenCalledTimes(1);
    expect(b?.docusign_status).toBe("signed");
    expect(b?.docusign_envelope_id).toMatch(/^TEST-ENV-/);
    expect(sess?.consumed_booking_id).toBe(first.bookingId);

    createCharge.mockClear();
    const reuse = await payAndBook(input("gate-d@example.com", 40), PAYMENT, s);
    console.log("already-consumed     ->", reuse.code, "|", reuse.error, "| createCharge calls:", createCharge.mock.calls.length);
    expect(reuse.code).toBe("agreement_used");
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("5. missing email on an online checkout -> refused, no charge", async () => {
    const s = await session("completed", "gate-e@example.com");
    const r = await payAndBook({ ...input("gate-e@example.com", 0), contactEmail: undefined, contactPhone: "6145550100" }, PAYMENT, s);
    console.log("no email             ->", r.code, "| createCharge calls:", createCharge.mock.calls.length);
    expect(r.code).toBe("no_email");
    expect(createCharge).not.toHaveBeenCalled();
  });
});
