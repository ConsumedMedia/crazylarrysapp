import { NextResponse, type NextRequest } from "next/server";
import { runQuickbooksRefresh } from "@/lib/cron/jobs";

export const dynamic = "force-dynamic";

/**
 * Layer 3 of the token refresh strategy — the idle keepalive. Logic lives in
 * lib/cron/jobs.ts (runQuickbooksRefresh) so /api/cron/daily can also call it
 * in sequence with the other three jobs.
 *
 *   GET /api/cron/quickbooks-refresh
 *   Authorization: Bearer $CL_CRON_SECRET
 *
 * Scheduled via /api/cron/daily + vercel.json — see the Vercel Cron open item.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runQuickbooksRefresh();
  if (!result.ok) {
    console.error("[cron/quickbooks-refresh]", result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json(result);
}
