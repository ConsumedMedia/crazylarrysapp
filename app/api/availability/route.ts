import { NextResponse, type NextRequest } from "next/server";
import { getRangeAvailability } from "@/lib/availability/queries";
import { DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;

/**
 * GET /api/availability?size=15yd&from=2026-10-01&to=2026-11-08
 *
 * Public (no auth) — the customer calendar is viewable without login. Reads
 * happen through the service-role client server-side; the key never leaves
 * the server. Input is capped as light abuse protection; real rate limiting
 * is a later concern.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const size = sp.get("size");
  const from = sp.get("from");
  const to = sp.get("to");
  const rentalDaysRaw = sp.get("rentalDays");

  if (!size || !isDumpsterSize(size)) {
    return NextResponse.json(
      { error: "size must be one of 10yd, 15yd, 20yd" },
      { status: 400 },
    );
  }
  if (!from || !to || !ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return NextResponse.json(
      { error: "from and to must be yyyy-mm-dd" },
      { status: 400 },
    );
  }
  if (to < from) {
    return NextResponse.json(
      { error: "to must be on or after from" },
      { status: 400 },
    );
  }

  const spanDays =
    (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `range too large (max ${MAX_RANGE_DAYS} days)` },
      { status: 400 },
    );
  }

  let rentalDays = DEFAULT_RENTAL_DAYS;
  if (rentalDaysRaw) {
    const n = Number(rentalDaysRaw);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return NextResponse.json(
        { error: "rentalDays must be an integer 1-60" },
        { status: 400 },
      );
    }
    rentalDays = n;
  }

  try {
    const result = await getRangeAvailability(size, from, to, rentalDays);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[/api/availability]", e);
    return NextResponse.json(
      { error: "availability lookup failed" },
      { status: 500 },
    );
  }
}
