import { NextResponse, type NextRequest } from "next/server";
import { runReminders } from "@/lib/cron/jobs";

export const dynamic = "force-dynamic";

/**
 * Daily 24-hour reminder sweep (delivery + pickup). Logic lives in
 * lib/cron/jobs.ts (runReminders) so /api/cron/daily can also call it in
 * sequence with the other three jobs. Idempotent — see runReminders.
 *
 *   GET /api/cron/reminders   Authorization: Bearer $CL_CRON_SECRET
 *
 * Scheduled via /api/cron/daily + vercel.json — see the Vercel Cron open item.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runReminders();
  return NextResponse.json({ ok: result.errors.length === 0, ...result });
}
