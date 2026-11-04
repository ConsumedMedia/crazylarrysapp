/**
 * Delivery-day warning: a booking is "unpaid and due" when it is still unpaid
 * and its delivery date is on or before the yard's today (America/New_York —
 * pass yardToday(), never a UTC date). Cancelled and returned bookings are
 * closed and never warn. Warn only; nothing is blocked. Independent of the
 * pay-link switch: unpaid staff bookings exist either way.
 */
export function isUnpaidDue(
  b: { payment_status?: string | null; delivery_date?: string | null; status?: string | null },
  yardToday: string,
): boolean {
  return (
    b.payment_status === "unpaid" &&
    typeof b.delivery_date === "string" &&
    b.delivery_date <= yardToday &&
    b.status !== "cancelled" &&
    b.status !== "returned"
  );
}

/** What the driver sees on the job page. */
export const DRIVER_NOT_PAID = {
  delivery: "Not paid: call the office before delivering",
  pickup: "Not paid: call the office",
} as const;
