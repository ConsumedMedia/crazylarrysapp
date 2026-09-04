"use server";

import { revalidatePath } from "next/cache";
import {
  createChangeRequest,
  cancelChangeRequest,
  ChangeRequestError,
} from "@/lib/bookings/change-requests";
import { NotAuthorizedError } from "@/lib/auth/requireCustomer";

export interface ChangeRequestActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): ChangeRequestActionState {
  if (e instanceof ChangeRequestError || e instanceof NotAuthorizedError) {
    return { ok: false, error: e.message };
  }
  console.error("[customer change request action]", e);
  return { ok: false, error: "Something went wrong." };
}

export async function submitChangeRequestAction(
  _prev: ChangeRequestActionState,
  formData: FormData,
): Promise<ChangeRequestActionState> {
  const bookingId = String(formData.get("bookingId") ?? "");
  const requestedDeliveryDate = String(formData.get("requestedDeliveryDate") ?? "") || null;
  const requestedPickupDate = String(formData.get("requestedPickupDate") ?? "") || null;
  const reason = String(formData.get("reason") ?? "");

  try {
    await createChangeRequest({
      bookingId,
      requestedDeliveryDate,
      requestedPickupDate,
      reason,
    });
    revalidatePath(`/account/bookings/${bookingId}`);
    revalidatePath("/account");
    return { ok: true, message: "Request sent — we'll follow up shortly." };
  } catch (e) {
    return toState(e);
  }
}

export async function cancelChangeRequestAction(
  _prev: ChangeRequestActionState,
  formData: FormData,
): Promise<ChangeRequestActionState> {
  const id = String(formData.get("id") ?? "");
  const bookingId = String(formData.get("bookingId") ?? "");
  try {
    await cancelChangeRequest(id);
    revalidatePath(`/account/bookings/${bookingId}`);
    revalidatePath("/account");
    return { ok: true, message: "Request withdrawn." };
  } catch (e) {
    return toState(e);
  }
}
