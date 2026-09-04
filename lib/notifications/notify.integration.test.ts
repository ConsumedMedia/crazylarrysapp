/**
 * Integration test — hits the linked Supabase project. Opt-in:
 *   CL_VERIFY_NOTIFY=1 npx vitest run lib/notifications/notify.integration.test.ts
 *
 * SEND-SAFE BY DEFAULT: this test forces CL_NOTIFICATIONS_ENABLED=0 for its
 * own process, regardless of whatever's actually set in .env.local — so
 * re-running it while iterating can NEVER place a real Quo/Resend call, even
 * if the ambient env has live sends on. To actually exercise real sends
 * (e.g. confirming a provider integration end to end), opt in explicitly:
 *   CL_VERIFY_NOTIFY=1 CL_VERIFY_NOTIFY_LIVE=1 npx vitest run lib/notifications/notify.integration.test.ts
 * Live mode still costs Quo credits per run and should be run deliberately,
 * not as part of routine "fix assertion, run again" iteration.
 *
 * Why this exists: the send layer is fire-and-forget by design; a regression
 * that made notify() throw, or stopped it writing to notifications_log, would
 * pass tsc + build silently. (This test used to inherit whatever
 * CL_NOTIFICATIONS_ENABLED was ambiently set to, which sent real duplicate SMS
 * to a real phone when re-run twice while fixing its own assertions — see
 * project memory. Any test capable of a real send or a real charge should
 * follow this same pattern: force safe-mode, require an explicit second flag
 * to go live.)
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import * as T from "./templates";

const RUN = process.env.CL_VERIFY_NOTIFY === "1";
const LIVE = process.env.CL_VERIFY_NOTIFY_LIVE === "1";

if (RUN && !LIVE) {
  // sms.ts / email.ts read this at call time, not import time, so setting it
  // here (before any test body runs) is enough to neuter every send below.
  process.env.CL_NOTIFICATIONS_ENABLED = "0";
}

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

describe.skipIf(!RUN)(
  `notify — render + log, never throws${LIVE ? " (LIVE — real sends)" : " (safe mode — sends forced off)"}`,
  () => {
    it("templates are within SMS sanity length and carry the key facts", () => {
      const r = T.bookingConfirmation({
        contactName: "Test Person",
        size: "20yd",
        deliveryDate: "2026-10-01",
        pickupDate: "2026-10-05",
        address: "1 Test St, Columbus, OH 43004",
        total: 401.05,
      });
      expect(r.sms).toContain("20 yd");
      expect(r.sms).toContain("$401.05");
      expect(r.sms.length).toBeLessThan(320);
      expect(r.email.html).toContain("<table");
    });

    it("writes an email + sms notifications_log row per event and never throws", async () => {
      // Imported here (after the safe-mode override above runs) rather than
      // at module top, so it's obvious the override happens before any
      // notify.ts code — even though the check is call-time, not import-time.
      const { notifyBookingConfirmation, notifyOverdue } = await import("./notify");

      const db = svc();
      const { data: booking } = await db
        .from("bookings")
        .select("id")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!booking) return; // no bookings in the project yet

      const bookingId = booking.id as string;
      const since = new Date(Date.now() - 2000).toISOString();

      await expect(notifyBookingConfirmation(bookingId)).resolves.toBeUndefined();
      await expect(notifyOverdue(bookingId)).resolves.toBeUndefined();

      const { data: rows } = await db
        .from("notifications_log")
        .select(
          "type, channel, delivery_status, error, body, failure_category, sent_at, provider_message_id",
        )
        .eq("booking_id", bookingId)
        .gte("created_at", since);

      const got = rows ?? [];
      expect(got.length).toBe(4);
      expect(new Set(got.map((r) => `${r.type}:${r.channel}`))).toEqual(
        new Set([
          "booking_confirmation:email",
          "booking_confirmation:sms",
          "overdue_notice:email",
          "overdue_notice:sms",
        ]),
      );

      for (const r of got) {
        expect(r.body).toBeTruthy();
        if (!LIVE) {
          // Safe mode: every send must have been neutered by the flag, never
          // an actual provider call.
          expect(r.delivery_status).toBe("skipped");
          expect(r.failure_category).toBe("disabled");
          expect(r.provider_message_id ?? null).toBeNull();
        } else {
          // Live mode: outcome depends on whatever's actually configured —
          // assert shape, not a specific status.
          expect(["sent", "failed", "skipped"]).toContain(r.delivery_status);
          if (r.delivery_status === "sent") {
            expect(r.sent_at).toBeTruthy();
            expect(r.error).toBeFalsy();
          } else {
            expect(r.error).toBeTruthy();
          }
        }
      }

      await db
        .from("notifications_log")
        .delete()
        .eq("booking_id", bookingId)
        .gte("created_at", since);
    });
  },
);
