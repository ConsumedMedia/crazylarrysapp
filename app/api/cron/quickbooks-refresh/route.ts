import { NextResponse, type NextRequest } from "next/server";
import { getValidAccessToken } from "@/lib/quickbooks/tokens";
import { quickBooksConfigured } from "@/lib/quickbooks/config";

export const dynamic = "force-dynamic";

/**
 * Layer 3 of the token refresh strategy — the idle keepalive.
 *
 * Larry can go days between online bookings, so the lazy pre-call refresh
 * (Layer 1) may never fire and the Intuit refresh token (100-day life, dies
 * earlier if unused) could lapse. This runs daily and forces a refresh if the
 * access token has less than ~24h left, rolling the refresh token forward.
 *
 *   GET /api/cron/quickbooks-refresh
 *   Authorization: Bearer $CL_CRON_SECRET
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!quickBooksConfigured()) {
    return NextResponse.json({ skipped: "not_configured" });
  }

  try {
    // 24h buffer: refresh unless the token has more than a day of life left.
    const { refreshed } = await getValidAccessToken(24 * 60 * 60);
    return NextResponse.json({ ok: true, refreshed });
  } catch (e) {
    const message = (e as Error).message;
    if (message === "QuickBooks is not connected") {
      return NextResponse.json({ skipped: "not_connected" });
    }
    console.error("[cron/quickbooks-refresh]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
