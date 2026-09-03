"use server";

import { revalidatePath } from "next/cache";
import { completeMyJob, DriverActionError } from "@/lib/driver/mutations";

export interface CompleteState {
  ok: boolean;
  error?: string;
}

export async function completeJobAction(
  _prev: CompleteState,
  formData: FormData,
): Promise<CompleteState> {
  const jobId = String(formData.get("job_id") ?? "");
  try {
    await completeMyJob(jobId);
    revalidatePath("/driver");
    revalidatePath(`/driver/${jobId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof DriverActionError) return { ok: false, error: e.message };
    console.error("[completeJobAction]", e);
    return { ok: false, error: "Couldn't mark it complete. Try again." };
  }
}
