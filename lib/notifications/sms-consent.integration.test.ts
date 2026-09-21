/**
 * Integration test — hits the linked Supabase project. Opt-in:
 *   CL_VERIFY_NOTIFY=1 npx vitest run lib/notifications/sms-consent.integration.test.ts
 *
 * SEND-SAFE BY DEFAULT: same pattern as notify.integration.test.ts — safe mode
 * forces CL_NOTIFICATIONS_ENABLED=0 so re-running while iterating can never
 * place a real Quo call. Live mode requires the explicit second flag:
 *   CL_VERIFY_NOTIFY=1 CL_VERIFY_NOTIFY_LIVE=1 npx vitest run lib/notifications/sms-consent.integration.test.ts
 * Live mode still redirects to CL_NOTIFICATIONS_TEST_TO (already set in
 * .env.local) rather than any real customer number, but it does place a real
 * Quo send and costs credits — run it deliberately.
 *
 * What this verifies: customers.sms_consent is threaded end to end — a
 * consenting customer's booking_confirmation SMS is actually attempted, and a
 * non-consenting customer's is skipped before ever reaching sendSms(), logged
 * with failure_category='no_consent' rather than silently dropped. Inserts
 * its own two throwaway customers/bookings directly (bypassing the
 * pricing-gated create_booking RPC, which is irrelevant to this feature) and
 * deletes everything it created, consent value included, when done.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

const RUN = process.env.CL_VERIFY_NOTIFY === "1";
const LIVE = process.env.CL_VERIFY_NOTIFY_LIVE === "1";

if (RUN && !LIVE) {
  process.env.CL_NOTIFICATIONS_ENABLED = "0";
}
// Dev's ambient CL_NOTIFICATIONS_ENABLED is 0 by design; LIVE mode means what
// it says, so force it on for this process only (still redirected to
// CL_NOTIFICATIONS_TEST_TO — see header comment).
if (RUN && LIVE) {
  process.env.CL_NOTIFICATIONS_ENABLED = "1";
}

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

const cleanupCustomerIds: string[] = [];
const cleanupBookingIds: string[] = [];

afterAll(async () => {
  if (!RUN || (cleanupBookingIds.length === 0 && cleanupCustomerIds.length === 0)) return;
  const db = svc();
  if (cleanupBookingIds.length) {
    await db.from("status_log").delete().in("entity_id", cleanupBookingIds);
    await db.from("jobs").delete().in("booking_id", cleanupBookingIds);
    await db.from("notifications_log").delete().in("booking_id", cleanupBookingIds);
    await db.from("bookings").delete().in("id", cleanupBookingIds);
  }
  if (cleanupCustomerIds.length) {
    await db.from("customers").delete().in("id", cleanupCustomerIds);
  }
});

describe.skipIf(!RUN)(
  `sms consent gate${LIVE ? " (LIVE — real sends, redirected to CL_NOTIFICATIONS_TEST_TO)" : " (safe mode — sends forced off)"}`,
  () => {
    it("sends only for the consenting customer; skips + logs no_consent for the other", async () => {
      const { notifyBookingConfirmation } = await import("./notify");
      const db = svc();

      async function makeBooking(label: string, smsConsent: boolean) {
        const { data: customer, error: custErr } = await db
          .from("customers")
          .insert({
            full_name: `SMS consent test — ${label}`,
            email: null,
            phone: "+16145550100",
            sms_consent: smsConsent,
          })
          .select("id")
          .single();
        if (custErr || !customer) throw new Error(`customer insert: ${custErr?.message}`);
        cleanupCustomerIds.push(customer.id as string);

        const { data: booking, error: bookErr } = await db
          .from("bookings")
          .insert({
            customer_id: customer.id,
            size_requested: "10yd",
            delivery_address: "1 Test St, Columbus, OH 43004",
            delivery_date: "2026-10-01",
            pickup_date: "2026-10-06",
            status: "confirmed",
            subtotal: 100,
            tax: 7,
            total: 107,
            docusign_status: "not_sent",
          })
          .select("id")
          .single();
        if (bookErr || !booking) throw new Error(`booking insert: ${bookErr?.message}`);
        cleanupBookingIds.push(booking.id as string);
        return booking.id as string;
      }

      const consentedId = await makeBooking("consented", true);
      const declinedId = await makeBooking("declined", false);

      await expect(notifyBookingConfirmation(consentedId)).resolves.toBeUndefined();
      await expect(notifyBookingConfirmation(declinedId)).resolves.toBeUndefined();

      const { data: rows } = await db
        .from("notifications_log")
        .select("booking_id, delivery_status, failure_category, error, provider_message_id")
        .in("booking_id", [consentedId, declinedId])
        .eq("channel", "sms");

      const consentedRow = (rows ?? []).find((r) => r.booking_id === consentedId);
      const declinedRow = (rows ?? []).find((r) => r.booking_id === declinedId);

      // Declined: must never reach sendSms — skipped, category no_consent,
      // regardless of live/safe mode (the consent check runs before the
      // CL_NOTIFICATIONS_ENABLED check).
      expect(declinedRow).toBeTruthy();
      expect(declinedRow!.delivery_status).toBe("skipped");
      expect(declinedRow!.failure_category).toBe("no_consent");
      expect(declinedRow!.provider_message_id ?? null).toBeNull();

      // Consented: attempted. In safe mode it's neutered by the ambient
      // disabled flag (proves consent alone didn't block it); in live mode it
      // must actually reach Quo and come back sent.
      expect(consentedRow).toBeTruthy();
      if (!LIVE) {
        expect(consentedRow!.delivery_status).toBe("skipped");
        expect(consentedRow!.failure_category).toBe("disabled");
      } else {
        expect(consentedRow!.delivery_status).toBe("sent");
        expect(consentedRow!.failure_category ?? null).toBeNull();
        expect(consentedRow!.provider_message_id).toBeTruthy();
      }
    });
  },
);
