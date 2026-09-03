/**
 * Integration test — hits the linked Supabase project. Opt-in:
 *   CL_VERIFY_NOTIFY=1 npx vitest run lib/notifications/notify.integration.test.ts
 *
 * Runs with notifications DISABLED (no CL_NOTIFICATIONS_ENABLED), so nothing is
 * sent to Quo/Resend — it asserts the render + notifications_log path and the
 * "never throws" contract. Cleans up the rows it writes.
 *
 * Why this exists: the send layer is fire-and-forget by design; a regression
 * that made notify() throw, or stopped it writing to notifications_log, would
 * pass tsc + build silently.
 */
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { notifyBookingConfirmation, notifyOverdue } from "./notify";
import * as T from "./templates";

const RUN = process.env.CL_VERIFY_NOTIFY === "1";

function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

describe.skipIf(!RUN)("notify — render + log, sends disabled", () => {
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
      .select("type, channel, delivery_status, error, body")
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
      expect(r.delivery_status).toBe("failed");
      expect(r.error).toBeTruthy();
      expect(r.body).toBeTruthy();
    }

    await db
      .from("notifications_log")
      .delete()
      .eq("booking_id", bookingId)
      .gte("created_at", since);
  });
});
