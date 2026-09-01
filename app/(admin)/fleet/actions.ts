"use server";

import { revalidatePath } from "next/cache";
import {
  changeDumpsterStatus,
  createDumpster,
  updateConditionNotes,
  DumpsterMutationError,
} from "@/lib/dumpsters/mutations";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface ActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): ActionState {
  if (e instanceof DumpsterMutationError || e instanceof NotAuthorizedError) {
    return { ok: false, error: e.message };
  }
  console.error("[fleet action]", e);
  return { ok: false, error: "Something went wrong. Try again." };
}

export async function changeStatusAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const to = String(formData.get("to") ?? "");
  try {
    await changeDumpsterStatus(id, to);
    revalidatePath("/fleet");
    return { ok: true, message: `Status updated to ${to.replace("_", " ")}.` };
  } catch (e) {
    return toState(e);
  }
}

export async function saveNotesAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const notes = String(formData.get("notes") ?? "");
  try {
    await updateConditionNotes(id, notes);
    revalidatePath("/fleet");
    return { ok: true, message: "Condition notes saved." };
  } catch (e) {
    return toState(e);
  }
}

export async function addCanAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const unit_number = String(formData.get("unit_number") ?? "");
  const size = String(formData.get("size") ?? "");
  try {
    const created = await createDumpster({ unit_number, size });
    revalidatePath("/fleet");
    return { ok: true, message: `${created.unit_number} added.` };
  } catch (e) {
    return toState(e);
  }
}
