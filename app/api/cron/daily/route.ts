import { NextResponse, type NextRequest } from "next/server";
import {
  runOverdue,
  runReminders,
  runQuickbooksRefresh,
  runQuickbooksSync,
} from "@/lib/cron/jobs";

export const dynamic = "force-dynamic";

/**
 * The one cron job Vercel Hobby's "2 jobs, once a day" limit actually needs —
 * runs all four daily jobs in sequence, each isolated in its own try/catch so
 * one failing job (e.g. QuickBooks down) doesn't stop the customer-facing
 * ones (overdue notices, reminders) from running.
 *
 * Order: overdue -> reminders -> quickbooks-refresh -> quickbooks-sync.
 * Customer-facing jobs run first so they're not starved by a slow QB call.
 *
 * The individual /api/cron/{overdue,reminders,quickbooks-refresh,quickbooks-sync}
 * routes still exist and share this same lib/cron/jobs.ts logic — useful for
 * manual/curl testing one job in isolation.
 *
 *   GET /api/cron/daily   Authorization: Bearer $CL_CRON_SECRET
 *
 * Wired to Vercel Cron via vercel.json once CRON_SECRET is set in Vercel to
 * the same value as CL_CRON_SECRET — see the Vercel Cron open item.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CL_CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const jobs: Array<[string, () => Promise<unknown>]> = [
    ["overdue", runOverdue],
    ["reminders", runReminders],
    ["quickbooks_refresh", runQuickbooksRefresh],
    ["quickbooks_sync", runQuickbooksSync],
  ];

  const results: Record<string, { ok: boolean; result?: unknown; error?: string }> = {};
  for (const [name, run] of jobs) {
    try {
      const result = await run();
      // runQuickbooksRefresh/runQuickbooksSync report failure via a returned
      // {ok:false} rather than throwing — surface that at this level too.
      const ok = typeof result === "object" && result !== null && "ok" in result
        ? (result as { ok: boolean }).ok
        : true;
      results[name] = ok ? { ok: true, result } : { ok: false, error: (result as { error?: string }).error, result };
    } catch (e) {
      const message = (e as Error).message;
      console.error(`[cron/daily] ${name} failed:`, message);
      results[name] = { ok: false, error: message };
    }
  }

  const ok = Object.values(results).every((r) => r.ok);
  return NextResponse.json({ ok, ranAt: new Date().toISOString(), jobs: results });
}
