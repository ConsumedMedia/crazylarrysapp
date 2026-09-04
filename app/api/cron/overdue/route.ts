import { NextResponse, type NextRequest } from "next/server";
import { runOverdue } from "@/lib/cron/jobs";

export const dynamic = "force-dynamic";

/**
 * Daily sweep: move active / pickup_scheduled bookings past their pickup_date
 * to 'overdue', then send an overdue notice (email + SMS) for each one flagged.
 * Logic lives in lib/cron/jobs.ts (runOverdue) so /api/cron/daily can also
 * call it in sequence with the other three jobs.
 *
 *   GET /api/cron/overdue   Authorization: Bearer $CL_CRON_SECRET
 *
 * Scheduled via /api/cron/daily + vercel.json — see the Vercel Cron open item.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runOverdue();
    return NextResponse.json(result);
  } catch (e) {
    console.error("[cron/overdue]", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
