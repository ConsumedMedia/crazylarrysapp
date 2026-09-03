import { randomBytes } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { assertOwner } from "@/lib/auth/requireStaff";
import {
  QB_AUTHORIZE_URL,
  QB_SCOPES,
  getQuickBooksConfig,
  quickBooksConfigured,
} from "@/lib/quickbooks/config";

export const dynamic = "force-dynamic";

/**
 * Owner-only. Starts the Intuit OAuth handshake: sets a CSRF state cookie and
 * 302s to the Intuit consent screen. No client secret is involved here — the
 * authorize URL carries only the public client id, redirect uri, scopes, and
 * the random state.
 */
export async function GET(request: NextRequest) {
  try {
    await assertOwner();
  } catch {
    return NextResponse.redirect(new URL("/login?denied=1", request.url));
  }

  if (!quickBooksConfigured()) {
    return NextResponse.redirect(
      new URL("/settings?qb=not_configured", request.url),
    );
  }

  const { clientId, redirectUri } = getQuickBooksConfig();
  const state = randomBytes(24).toString("hex");

  cookies().set("qb_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes to complete the handshake
  });

  const authorizeUrl = new URL(QB_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", QB_SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  return NextResponse.redirect(authorizeUrl);
}
