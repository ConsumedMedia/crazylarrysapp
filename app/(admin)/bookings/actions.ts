"use server";

import { revalidatePath } from "next/cache";
import {
  changeBookingStatus,
  setDocusignStatus,
  refundBooking,
  applyDrivewayFee,
  removeDrivewayFee,
  BookingMutationError,
} from "@/lib/bookings/mutations";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface BookingActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): BookingActionState {
  if (e instanceof BookingMutationError || e instanceof NotAuthorizedError) {
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
    await changeBookingStatus(id, to);
    revalidatePath(`/bookings/${id}`);
    revalidatePath("/bookings");
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
