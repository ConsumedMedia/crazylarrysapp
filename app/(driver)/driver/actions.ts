"use server";

import { revalidatePath } from "next/cache";
import { completeMyJob, DriverActionError } from "@/lib/driver/mutations";

export interface CompleteState {
  ok: boolean;
  error?: string;
  photoWarning?: string;
}

export async function completeJobAction(
  _prev: CompleteState,
  formData: FormData,
): Promise<CompleteState> {
  const jobId = String(formData.get("job_id") ?? "");
  const photoStoragePath = String(formData.get("photo_storage_path") ?? "") || null;
  const photoFailed = formData.get("photo_failed") === "1";
  try {
    await completeMyJob(jobId, photoStoragePath);
    revalidatePath("/driver");
    revalidatePath(`/driver/${jobId}`);
    revalidatePath("/driver/done");
    return {
      ok: true,
      photoWarning: photoFailed
        ? "Marked complete — the photo didn't upload (no signal?). Retake it from a stronger-signal spot if you can before you leave."
        : undefined,
    };
  } catch (e) {
    if (e instanceof DriverActionError) return { ok: false, error: e.message };
    console.error("[completeJobAction]", e);
    return { ok: false, error: "Couldn't mark it complete. Try again." };
  }
}
