import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * Daily sweep: move active / pickup_scheduled bookings past their pickup_date
 * to 'overdue'. Calls the idempotent public.mark_overdue_bookings() RPC.
 *
 * Not yet wired to a scheduler. Trigger manually, or point a cron at it:
 *   GET /api/cron/overdue  with  Authorization: Bearer $CL_CRON_SECRET
 *
 * TODO: schedule via Supabase scheduled functions or a platform cron; also
 * flip each overdue booking's assigned dumpster to 'overdue' once units are
 * assigned at dispatch (Phase 6).
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
  return NextResponse.json({ marked_overdue: data ?? 0 });
}
