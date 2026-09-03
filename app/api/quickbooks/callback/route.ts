import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { assertOwner } from "@/lib/auth/requireStaff";
import { connectWithAuthCode } from "@/lib/quickbooks/tokens";
import { syncCompanyName } from "@/lib/quickbooks/company";

export const dynamic = "force-dynamic";

/**
 * Intuit redirects the owner's browser here after consent:
 *   /api/quickbooks/callback?code=...&realmId=...&state=...
 *
 * Guards, in order:
 *   1. Intuit returned an error param -> bail.
 *   2. state param matches the httpOnly cookie set by /connect (CSRF).
 *   3. The current session is still the owner.
 * Then exchange the code for tokens (server-to-server, Basic auth with the
 * client secret — never exposed), persist, and best-effort fetch the company
 * name. Redirect back to /settings.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const settings = (q: string) => NextResponse.redirect(new URL(`/settings?qb=${q}`, request.url));

  const err = params.get("error");
  if (err) {
    return settings(`error`);
  }

  const code = params.get("code");
  const realmId = params.get("realmId");
  const state = params.get("state");
  if (!code || !realmId || !state) {
    return settings("error");
  }

  const cookieState = cookies().get("qb_oauth_state")?.value;
  cookies().delete("qb_oauth_state");
  if (!cookieState || cookieState !== state) {
    return settings("state_mismatch");
  }

  let owner;
  try {
    owner = await assertOwner();
  } catch {
    return NextResponse.redirect(new URL("/login?denied=1", request.url));
  }

  try {
    await connectWithAuthCode({ code, realmId, connectedBy: owner.userId });
  } catch (e) {
    console.error("[quickbooks/callback] token exchange failed:", (e as Error).message);
    return settings("error");
  }

  // Non-fatal: connection is already valid even if this fails.
  try {
    await syncCompanyName(realmId);
  } catch {
    /* ignore */
  }

  return settings("connected");
}
