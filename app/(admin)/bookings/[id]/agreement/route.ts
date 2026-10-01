import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth/requireStaff";
import { createClient } from "@/lib/supabase/server";
import { AGREEMENT_BUCKET, signedAgreementInfo } from "@/lib/docusign/agreement";

export const dynamic = "force-dynamic";

/**
 * GET /bookings/<id>/agreement — open the booking's signed rental agreement.
 *
 * Same gate as the rest of the booking page (requireStaff), then a 60-second
 * signed URL minted with the staff member's OWN session, so the bucket's
 * "staff read" storage policy is checked independently of this code. Never a
 * permanent or public link.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  await requireStaff();

  const info = await signedAgreementInfo(params.id);
  if (!info?.documentPath) {
    return NextResponse.json(
      { error: "No stored signed agreement for this booking." },
      { status: 404 },
    );
  }

  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from(AGREEMENT_BUCKET)
    .createSignedUrl(info.documentPath, 60);
  if (error || !data?.signedUrl) {
    console.error("[bookings/agreement] signed URL failed:", error?.message);
    return NextResponse.json({ error: "Couldn't open the agreement." }, { status: 403 });
  }

  return NextResponse.redirect(data.signedUrl, { status: 302 });
}
