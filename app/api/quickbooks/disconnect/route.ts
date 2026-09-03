import { NextResponse, type NextRequest } from "next/server";
import { assertOwner } from "@/lib/auth/requireStaff";
import { disconnect } from "@/lib/quickbooks/tokens";

export const dynamic = "force-dynamic";

/** Owner-only. Revokes the token at Intuit and clears the stored connection. */
export async function POST(request: NextRequest) {
  try {
    await assertOwner();
  } catch {
    return NextResponse.redirect(new URL("/login?denied=1", request.url), 303);
  }

  try {
    await disconnect();
  } catch (e) {
    console.error("[quickbooks/disconnect]", (e as Error).message);
    return NextResponse.redirect(
      new URL("/settings?qb=error", request.url),
      303,
    );
  }
  return NextResponse.redirect(
    new URL("/settings?qb=disconnected", request.url),
    303,
  );
}
