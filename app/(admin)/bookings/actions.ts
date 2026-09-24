"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  changeBookingStatus,
  setDocusignStatus,
  refundBooking,
  applyDrivewayFee,
  removeDrivewayFee,
  recordManualPayment,
  sendBookingInvoice,
  checkInvoicePayment,
  BookingMutationError,
} from "@/lib/bookings/mutations";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";
import { staffCreateBooking } from "@/lib/bookings/staff-create";
import { BookingCreateError } from "@/lib/bookings/create";
import { notifyBookingConfirmation } from "@/lib/notifications/notify";
import { isDumpsterSize } from "@/lib/dumpsters/state-machine";

export interface BookingActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): BookingActionState {
  if (
    e instanceof BookingMutationError ||
    e instanceof BookingCreateError ||
    e instanceof NotAuthorizedError
  ) {
    return { ok: false, error: e.message };
  }
  console.error("[booking action]", e);
  return { ok: false, error: "Something went wrong." };
}

export async function changeStatusAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  const to = String(formData.get("to") ?? "");
  try {
    const { warning } = await changeBookingStatus(id, to);
    revalidatePath(`/bookings/${id}`);
    revalidatePath("/bookings");
    if (warning) return { ok: false, error: warning };
    return { ok: true, message: `Booking → ${to.replace("_", " ")}.` };
  } catch (e) {
    return toState(e);
  }
}

export async function setAgreementAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  const to = String(formData.get("to") ?? "");
  try {
    await setDocusignStatus(id, to);
    revalidatePath(`/bookings/${id}`);
    return { ok: true, message: `Agreement → ${to.replace("_", " ")}.` };
  } catch (e) {
    return toState(e);
  }
}

export async function refundAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  const cancel = String(formData.get("cancel") ?? "") === "1";
  try {
    const { refundKind } = await refundBooking(id, { cancel });
    revalidatePath(`/bookings/${id}`);
    revalidatePath("/bookings");
    const did = refundKind === "void" ? "voided (pre-settlement)" : "refunded";
    return {
      ok: true,
      message: cancel
        ? `Payment ${did} and booking cancelled.`
        : `Payment ${did}.`,
    };
  } catch (e) {
    return toState(e);
  }
}

export async function applyDrivewayFeeAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  try {
    const booking = await applyDrivewayFee(id, note);
    revalidatePath(`/bookings/${id}`);
    return {
      ok: true,
      message: `Driveway fee applied ($${Number(booking.driveway_fee_amount).toFixed(2)}).`,
    };
  } catch (e) {
    return toState(e);
  }
}

export async function removeDrivewayFeeAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  try {
    await removeDrivewayFee(id);
    revalidatePath(`/bookings/${id}`);
    return { ok: true, message: "Driveway fee removed." };
  } catch (e) {
    return toState(e);
  }
}

/**
 * Staff manual booking (phone / in person). No payment is taken here — the
 * booking starts unpaid; staff settle it from the booking page (cash/check or
 * a QuickBooks invoice). The confirmation goes out like the online flow
 * (SMS only with consent), showing the amount as due.
 */
export async function createStaffBookingAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const f = (k: string) => String(formData.get(k) ?? "").trim();
  const size = f("size");
  if (!isDumpsterSize(size)) return { ok: false, error: "Pick a dumpster size." };

  const placement = f("placement");
  const notes = f("placementNotes");
  let bookingId: string;
  try {
    ({ bookingId } = await staffCreateBooking({
      size,
      deliveryDate: f("deliveryDate"),
      street: f("street"),
      city: f("city"),
      state: f("state"),
      zip: f("zip"),
      placementNotes: placement
        ? `Placement: ${placement}${notes ? ` — ${notes}` : ""}`
        : notes || undefined,
      debrisType: f("debrisType") || undefined,
      contactName: f("contactName"),
      contactEmail: f("contactEmail") || undefined,
      contactPhone: f("contactPhone") || undefined,
      companyName: f("companyName") || undefined,
      smsConsent: formData.get("smsConsent") === "on",
      customerId: f("customerId") || null,
    }));
  } catch (e) {
    return toState(e);
  }

  await notifyBookingConfirmation(bookingId);
  revalidatePath("/bookings");
  redirect(`/bookings/${bookingId}?created=1`);
}

export async function recordPaymentAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  const method = String(formData.get("method") ?? "");
  const reference = String(formData.get("reference") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  try {
    const { qboInvoiceId } = await recordManualPayment(id, { method, reference, note });
    revalidatePath(`/bookings/${id}`);
    revalidatePath("/bookings");
    return {
      ok: true,
      message: qboInvoiceId
        ? `Marked paid by ${method}. Recorded in QuickBooks (invoice ${qboInvoiceId}).`
        : `Marked paid by ${method}. QuickBooks didn't take it yet — the daily sync will retry (see Payment details).`,
    };
  } catch (e) {
    return toState(e);
  }
}

export async function sendInvoiceAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  const email = String(formData.get("email") ?? "");
  try {
    const r = await sendBookingInvoice(id, email);
    revalidatePath(`/bookings/${id}`);
    return {
      ok: true,
      message: `${r.resent ? "Re-sent" : "Sent"} QuickBooks invoice ${r.qbInvoiceId} to ${email.trim()}.${
        r.invoiceLink ? "" : " QuickBooks didn't return a pay link — check that QuickBooks Payments is on for the company."
      }`,
    };
  } catch (e) {
    revalidatePath(`/bookings/${id}`);
    return toState(e);
  }
}

export async function checkPaymentAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  try {
    const r = await checkInvoicePayment(id);
    revalidatePath(`/bookings/${id}`);
    revalidatePath("/bookings");
    if (r.problem) return { ok: false, error: r.problem };
    return {
      ok: true,
      message: r.paid
        ? "Paid — QuickBooks shows the invoice fully paid. Booking marked paid."
        : "Not paid yet in QuickBooks.",
    };
  } catch (e) {
    return toState(e);
  }
}
