import { NextResponse } from "next/server";

/**
 * DocuSign Connect webhook — STUB.
 *
 * Phase 4 has no live DocuSign API. Agreement status is advanced manually by
 * staff (admin booking detail -> "Mark agreement signed", calling
 * set_booking_docusign_status).
 *
 * When DocuSign Connect is configured in a later phase, this endpoint will:
 *   1. verify the HMAC signature (X-DocuSign-Signature-1) against
 *      DOCUSIGN_CONNECT_HMAC_KEY
 *   2. parse the envelope-completed event, map envelopeId -> booking
 *   3. call set_booking_docusign_status(bookingId, 'signed') via service role
 *
 * Until then it accepts nothing.
 */
export function POST() {
  return NextResponse.json(
    { error: "DocuSign webhook not configured in this phase" },
    { status: 501 },
  );
}

export function GET() {
  return NextResponse.json({ status: "stub", phase: 4 }, { status: 200 });
}
