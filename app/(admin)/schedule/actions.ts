"use server";

import { revalidatePath } from "next/cache";
import { createBlock, deleteBlock, BlockError } from "@/lib/availability/blocks";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";

export interface BlockActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

function toState(e: unknown): BlockActionState {
  if (e instanceof BlockError || e instanceof NotAuthorizedError) {
    return { ok: false, error: e.message };
  }
  console.error("[schedule action]", e);
  return { ok: false, error: "Something went wrong." };
}

export async function createBlockAction(
  _prev: BlockActionState,
  formData: FormData,
): Promise<BlockActionState> {
  const rawSize = String(formData.get("size") ?? "");
  try {
    await createBlock({
      size: rawSize === "" || rawSize === "all" ? null : rawSize,
      start_date: String(formData.get("start_date") ?? ""),
      end_date: String(formData.get("end_date") ?? ""),
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath("/schedule");
    return { ok: true, message: "Block added." };
  } catch (e) {
    return toState(e);
  }
}

export async function deleteBlockAction(
  _prev: BlockActionState,
  formData: FormData,
): Promise<BlockActionState> {
  try {
    await deleteBlock(String(formData.get("id") ?? ""));
    revalidatePath("/schedule");
    return { ok: true, message: "Block removed." };
  } catch (e) {
    return toState(e);
  }
}
