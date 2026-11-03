import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets, image optimization files, inbound
     * webhooks (signature-verified, no session — refreshing one would only
     * add a Supabase round trip before the handler answers) and the public
     * /pay/<token> page (the token is its only credential; it must never
     * read or refresh whoever's session the browser happens to carry).
     */
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks/|pay/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
