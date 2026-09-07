import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireDriver } from "@/lib/auth/requireDriver";
import { notifyJobComplete } from "@/lib/notifications/notify";

export class DriverActionError extends Error {
  code: string;
  constructor(message: string, code = "error") {
    super(message);
    this.name = "DriverActionError";
    this.code = code;
  }
}

/**
 * Driver marks their own job complete. complete_job is SECURITY DEFINER and
 * checks "is_staff() OR owns this job" itself, then runs the downstream
 * booking + dumpster transitions.
 *
 * `photoStoragePath`, if given, is a file the client already uploaded
 * directly to the job-photos bucket *before* calling this — completion
 * itself never waits on or depends on the upload. If the row insert here
 * fails after a successful upload (rare — this is a tiny insert right after
 * a completed RPC call), the file still exists in storage; we log and move
 * on rather than fail a job that's already completed over it.
 */
export async function completeMyJob(
  jobId: string,
  photoStoragePath?: string | null,
): Promise<void> {
  const ctx = await requireDriver();
  const supabase = createClient();
  const { data, error } = await supabase.rpc("complete_job", { p_job_id: jobId });
  if (error) {
    const map: Record<string, string> = {
      "42501": "This job isn't assigned to you.",
      "23514": "This job can't be completed right now.",
      P0002: "That job no longer exists.",
    };
    throw new DriverActionError(
      map[error.code ?? ""] ?? error.message,
      error.code ?? "rpc_failed",
    );
  }

  if (photoStoragePath) {
    const { error: photoErr } = await supabase
      .from("job_photos")
      .insert({ job_id: jobId, storage_path: photoStoragePath, uploaded_by: ctx.userId });
    if (photoErr) {
      console.error(
        `[completeMyJob] job ${jobId} completed but photo row insert failed (file at ${photoStoragePath} may be orphaned):`,
        photoErr.message,
      );
    }
  }

  const job = data as { id: string; type: "delivery" | "pickup"; booking_id: string } | null;
  if (job?.booking_id) {
    await notifyJobComplete({ id: job.id, type: job.type, booking_id: job.booking_id });
  }
}
