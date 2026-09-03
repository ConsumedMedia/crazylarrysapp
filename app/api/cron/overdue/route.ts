import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { notifyOverdue } from "@/lib/notifications/notify";

export const dynamic = "force-dynamic";

/**
 * Daily sweep: move active / pickup_scheduled bookings past their pickup_date
 * to 'overdue', then send an overdue notice (email + SMS) for each one flagged.
 *
 * mark_overdue_bookings() returns the ids it flagged this run.
 *
 *   GET /api/cron/overdue   Authorization: Bearer $CL_CRON_SECRET
 *
 * NOTE: not yet wired to a scheduler — see the Vercel Cron open item.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("mark_overdue_bookings");
  if (error) {
    console.error("[cron/overdue]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const ids: string[] = Array.isArray(data)
    ? data.map((r: unknown) =>
        typeof r === "string" ? r : (r as { mark_overdue_bookings?: string }).mark_overdue_bookings ?? "",
      ).filter(Boolean)
    : [];

  for (const id of ids) {
    await notifyOverdue(id);
  }

  return NextResponse.json({ marked_overdue: ids.length, booking_ids: ids });
}
