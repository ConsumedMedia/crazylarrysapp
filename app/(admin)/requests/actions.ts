"use server";

import { revalidatePath } from "next/cache";
import { resolveChangeRequest, ChangeRequestError } from "@/lib/bookings/change-requests";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface RequestActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function resolveRequestAction(
  _prev: RequestActionState,
  formData: FormData,
): Promise<RequestActionState> {
  const id = String(formData.get("id") ?? "");
  const bookingId = String(formData.get("bookingId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const staffResponse = String(formData.get("staffResponse") ?? "");

  if (decision !== "approved" && decision !== "declined") {
    return { ok: false, error: "Unknown decision." };
  }

  try {
    await resolveChangeRequest(id, decision, staffResponse);
    revalidatePath("/requests");
    revalidatePath(`/bookings/${bookingId}`);
    return {
      ok: true,
      message: decision === "approved" ? "Request approved." : "Request declined.",
    };
  } catch (e) {
    if (e instanceof ChangeRequestError || e instanceof NotAuthorizedError) {
      return { ok: false, error: e.message };
    }
    console.error("[resolveRequestAction]", e);
    return { ok: false, error: "Something went wrong." };
  }
}
