"use server";

import { revalidatePath } from "next/cache";
import {
  assignJob,
  unassignJob,
  setRouteOrder,
  confirmJobTags,
  DispatchError,
} from "@/lib/dispatch/mutations";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface DispatchActionState {
  ok: boolean;
  error?: string;
  message?: string;
  hint?: string;
  detail?: string | null;
}

function toState(e: unknown): DispatchActionState {
  if (e instanceof DispatchError) {
    return { ok: false, error: e.message, hint: e.hint ?? undefined, detail: e.detail };
  }
  if (e instanceof NotAuthorizedError) return { ok: false, error: e.message };
  console.error("[dispatch action]", e);
  return { ok: false, error: "Something went wrong." };
}

export async function assignJobAction(
  _prev: DispatchActionState,
  formData: FormData,
): Promise<DispatchActionState> {
  try {
    await assignJob({
      jobId: String(formData.get("job_id") ?? ""),
      driverId: String(formData.get("driver_id") ?? ""),
      dumpsterId: String(formData.get("dumpster_id") ?? "") || null,
      override: formData.get("override") === "true",
    });
    revalidatePath("/dispatch");
    return { ok: true, message: "Assigned." };
  } catch (e) {
    return toState(e);
  }
}

export async function unassignJobAction(
  _prev: DispatchActionState,
  formData: FormData,
): Promise<DispatchActionState> {
  try {
    await unassignJob(String(formData.get("job_id") ?? ""));
    revalidatePath("/dispatch");
    return { ok: true, message: "Unassigned." };
  } catch (e) {
    return toState(e);
  }
}

export async function reorderAction(
  _prev: DispatchActionState,
  formData: FormData,
): Promise<DispatchActionState> {
  try {
    await setRouteOrder(
      String(formData.get("driver_id") ?? ""),
      String(formData.get("date") ?? ""),
      JSON.parse(String(formData.get("job_ids") ?? "[]")) as string[],
    );
    revalidatePath("/dispatch");
    return { ok: true };
  } catch (e) {
    return toState(e);
  }
}

export async function confirmTagsAction(
  _prev: DispatchActionState,
  formData: FormData,
): Promise<DispatchActionState> {
  try {
    await confirmJobTags(
      String(formData.get("booking_id") ?? ""),
      formData.getAll("tags").map(String),
    );
    revalidatePath("/dispatch");
    return { ok: true, message: "Tags confirmed." };
  } catch (e) {
    return toState(e);
  }
}
