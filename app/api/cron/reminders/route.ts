import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  notifyDeliveryReminder,
  notifyPickupReminder,
  alreadyNotified,
} from "@/lib/notifications/notify";

export const dynamic = "force-dynamic";

/**
 * Daily 24-hour reminder sweep.
 *
 *   delivery_reminder — bookings with delivery_date = tomorrow, status 'confirmed'
 *   pickup_reminder   — bookings with pickup_date  = tomorrow,
 *                       status in ('active','pickup_scheduled')
 *
 * Idempotent: skips a booking that already has a log row of that type within
 * 48h, so a re-run (or a missed day re-fired) doesn't double-send.
 *
 *   GET /api/cron/reminders   Authorization: Bearer $CL_CRON_SECRET
 *
 * NOTE: not yet wired to a scheduler — see the Vercel Cron open item.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const service = createServiceClient();

  // tomorrow in UTC (delivery_date / pickup_date are plain dates)
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);

  const [deliveries, pickups] = await Promise.all([
    service
      .from("bookings")
      .select("id")
      .eq("delivery_date", tomorrow)
      .eq("status", "confirmed"),
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

  return NextResponse.json({ ok: out.errors.length === 0, ...out });
}
