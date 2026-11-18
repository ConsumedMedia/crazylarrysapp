import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertOwner } from "@/lib/auth/requireStaff";
import { isAgreementMode, type AgreementMode } from "./mode-shared";

/**
 * The owner's agreement mode (cl_agreement_settings.mode, migration
 * 20261117000000), written on the signed-in owner's own session, never
 * service_role: RLS lets only owners update, and only the mode column is
 * granted. updated_by is stamped by the database. Readers use lib/docusign/mode.
 */

export function parseAgreementModeForm(fd: FormData): { ok: true; value: AgreementMode } | { ok: false; error: string } {
  const v = String(fd.get("agreement_mode") ?? "");
  return isAgreementMode(v) ? { ok: true, value: v } : { ok: false, error: "Pick PowerForm and checkbox, or DocuSign." };
}

/** Table missing: Postgres (42P01) or PostgREST's schema cache (PGRST205). */
const NOT_THERE = new Set(["42P01", "PGRST205"]);

export async function saveAgreementMode(mode: AgreementMode): Promise<void> {
  await assertOwner();
  if (!isAgreementMode(mode)) throw new Error("Pick PowerForm and checkbox, or DocuSign.");
  const { data, error } = await createClient()
    .from("cl_agreement_settings")
    .update({ mode })
    .eq("id", true)
    .select("mode");
  if (error) {
    if (error.code && NOT_THERE.has(error.code)) {
      throw new Error("The agreement setting isn't in the database yet (migration 20261117000000).");
    }
    if (error.code === "42501") throw new Error("Only an owner can change the rental agreement setting.");
    throw new Error("The rental agreement setting couldn't be saved. Try again.");
  }
  if (!Array.isArray(data) || data.length !== 1) {
    // RLS let nothing through: not an owner in the database's eyes.
    throw new Error("Only an owner can change the rental agreement setting.");
  }
}
