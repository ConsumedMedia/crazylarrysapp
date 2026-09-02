"use server";

import { revalidatePath } from "next/cache";
import {
  changeBookingStatus,
  setDocusignStatus,
  devSimulatePayment,
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

export async function devPayAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const id = String(formData.get("id") ?? "");
  try {
    await devSimulatePayment(id);
    revalidatePath(`/bookings/${id}`);
    return { ok: true, message: "Dev: marked paid (no charge)." };
  } catch (e) {
    return toState(e);
  }
}
