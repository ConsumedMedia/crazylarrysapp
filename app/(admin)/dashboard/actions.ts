"use server";

import { revalidatePath } from "next/cache";
import { NotAuthorizedError } from "@/lib/auth/requireStaff";
import { resolveFailedRefund, ResolveError } from "@/lib/payments/failed-refunds";

export interface ResolveState {
  ok: boolean;
  error?: string;
}

/** Mark a failed compensating refund handled (resolve_payment_attempt records who and when). */
export async function resolveRefundAction(_prev: ResolveState, formData: FormData): Promise<ResolveState> {
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "Unknown entry." };
  try {
    await resolveFailedRefund(id);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    if (e instanceof ResolveError || e instanceof NotAuthorizedError) return { ok: false, error: e.message };
    return { ok: false, error: "Something went wrong. Refresh and try again." };
  }
}
