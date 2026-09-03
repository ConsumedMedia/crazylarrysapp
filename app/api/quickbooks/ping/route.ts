import { NextResponse } from "next/server";
import { assertOwner } from "@/lib/auth/requireStaff";
import { getValidAccessToken } from "@/lib/quickbooks/tokens";
import { quickbooksJson } from "@/lib/quickbooks/client";

export const dynamic = "force-dynamic";

/**
 * DEV ONLY (gated on CL_ENABLE_DEV_STUBS). Owner-only. Exercises the full
 * token + API path end to end so the OAuth handshake can be verified before
 * the payment flow exists: it reports whether getValidAccessToken() refreshed,
 * then calls the Accounting API companyinfo endpoint.
 *
 * Test the refresh path:
 *   1. psql / supabase db query:  update public.quickbooks_connection
 *        set access_token_expires_at = now() - interval '1 min' where id = true;
 *   2. GET /api/quickbooks/ping  -> "refreshed": true
 */
export async function GET() {
  if (process.env.CL_ENABLE_DEV_STUBS !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    await assertOwner();
  } catch {
    return NextResponse.json({ error: "owner only" }, { status: 403 });
  }

  try {
    const tok = await getValidAccessToken();
    const info = await quickbooksJson<{
      CompanyInfo?: { CompanyName?: string };
    }>(`companyinfo/${tok.realmId}`);
    return NextResponse.json({
      ok: true,
      refreshed: tok.refreshed,
      realmId: tok.realmId,
      companyName: info.CompanyInfo?.CompanyName ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
