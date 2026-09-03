import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireDriver } from "@/lib/auth/requireDriver";

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
 */
export async function completeMyJob(jobId: string): Promise<void> {
  await requireDriver();
  const supabase = createClient();
  const { error } = await supabase.rpc("complete_job", { p_job_id: jobId });
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
}
