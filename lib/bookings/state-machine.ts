/**
 * Booking lifecycle state machine — UI MIRROR ONLY.
 *
 * Authoritative enforcer: public.set_booking_status /
 * public.booking_transition_allowed (migration 20260901100000). This mirror
 * only decides which action buttons the admin booking detail renders.
 * state-machine.test.ts locks the matrix.
 */

export const BOOKING_STATUSES = [
  "confirmed",
  "delivered",
  "active",
  "pickup_scheduled",
  "returned",
  "overdue",
  "cancelled",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const DOCUSIGN_STATUSES = ["not_sent", "pending", "signed"] as const;
export type DocusignStatus = (typeof DOCUSIGN_STATUSES)[number];

/** Mirrors public.booking_transition_allowed. */
export function bookingTransitionAllowed(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  if (from === to) return false;
  if (to === "cancelled") return from !== "returned" && from !== "cancelled";
  switch (from) {
    case "confirmed":
      return to === "delivered";
    case "delivered":
      return to === "active";
    case "active":
      return to === "pickup_scheduled" || to === "overdue";
    case "pickup_scheduled":
      return to === "returned" || to === "overdue";
    case "overdue":
      return to === "pickup_scheduled" || to === "returned";
    default:
      return false; // returned, cancelled are terminal
  }
}

export function nextBookingStatuses(from: BookingStatus): BookingStatus[] {
  return BOOKING_STATUSES.filter((s) => bookingTransitionAllowed(from, s));
}

export function isBookingStatus(v: unknown): v is BookingStatus {
  return (
    typeof v === "string" && (BOOKING_STATUSES as readonly string[]).includes(v)
  );
}

export function isDocusignStatus(v: unknown): v is DocusignStatus {
  return (
    typeof v === "string" && (DOCUSIGN_STATUSES as readonly string[]).includes(v)
  );
}

export const BOOKING_STATUS_META: Record<
  BookingStatus,
  { label: string; brand: "teal" | "purple" | "pink" | "orange" | "gray-st" }
> = {
  confirmed: { label: "Confirmed", brand: "purple" },
  delivered: { label: "Delivered", brand: "teal" },
  active: { label: "On site", brand: "pink" },
  pickup_scheduled: { label: "Pickup scheduled", brand: "teal" },
  returned: { label: "Returned", brand: "gray-st" },
  overdue: { label: "Overdue", brand: "orange" },
  cancelled: { label: "Cancelled", brand: "gray-st" },
};

export const DOCUSIGN_META: Record<DocusignStatus, string> = {
  not_sent: "Not sent",
  pending: "Awaiting signature",
  signed: "Signed",
};
