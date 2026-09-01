import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import {
  isDumpsterSize,
  isDumpsterStatus,
  type DumpsterSize,
  type DumpsterStatus,
} from "./state-machine";
import type { DumpsterRow } from "./types";

export class DumpsterMutationError extends Error {
  code: string;
  constructor(message: string, code = "unknown") {
    super(message);
    this.name = "DumpsterMutationError";
    this.code = code;
  }
}

// Larry's fleet convention: "<size>-<sequence>", e.g. 20-30, 15-06, 10-01.
const UNIT_NUMBER_RE = /^(10|15|20)-\d{2,3}$/;
const SIZE_PREFIX: Record<string, string> = {
  "10yd": "10",
  "15yd": "15",
  "20yd": "20",
};

/**
 * Create a new unit. Starts 'available'; the dumpsters_log_created trigger
 * writes the opening status_log row (old_status NULL).
 */
export async function createDumpster(input: {
  unit_number: string;
  size: string;
}): Promise<DumpsterRow> {
  await assertStaff();

  const unit_number = input.unit_number.trim();
  if (!isDumpsterSize(input.size)) {
    throw new DumpsterMutationError("Unknown dumpster size.", "bad_size");
  }
  if (!UNIT_NUMBER_RE.test(unit_number)) {
    throw new DumpsterMutationError(
      "Unit number must look like 20-30 (size prefix + sequence).",
      "bad_unit_number",
    );
  }
  if (unit_number.split("-")[0] !== SIZE_PREFIX[input.size]) {
    throw new DumpsterMutationError(
      `A ${input.size} unit number should start with "${SIZE_PREFIX[input.size]}-".`,
      "prefix_size_mismatch",
    );
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("dumpsters")
    .insert({ unit_number, size: input.size as DumpsterSize })
    .select("id, unit_number, size, status, condition_notes, created_at, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new DumpsterMutationError(
        `${unit_number} already exists.`,
        "duplicate",
      );
    }
    throw new DumpsterMutationError(error.message, error.code ?? "insert_failed");
  }
  return data as DumpsterRow;
}

export async function updateConditionNotes(
  id: string,
  notes: string,
): Promise<void> {
  await assertStaff();
  const trimmed = notes.trim();
  const supabase = createClient();
  const { error } = await supabase
    .from("dumpsters")
    .update({ condition_notes: trimmed.length ? trimmed : null })
    .eq("id", id);
  if (error) {
    throw new DumpsterMutationError(error.message, error.code ?? "update_failed");
  }
}

/**
 * The ONLY status-change path. Delegates to the authoritative Postgres RPC,
 * which validates the transition, updates the row, and writes status_log in a
 * single transaction with changed_by = auth.uid().
 */
export async function changeDumpsterStatus(
  id: string,
  to: string,
): Promise<DumpsterRow> {
  await assertStaff();
  if (!isDumpsterStatus(to)) {
    throw new DumpsterMutationError("Unknown target status.", "bad_status");
  }

  const supabase = createClient();
  // set_dumpster_status RETURNS public.dumpsters (a single composite row),
  // so PostgREST hands back one object directly — no .single().
  const { data, error } = await supabase.rpc("set_dumpster_status", {
    p_dumpster_id: id,
    p_to: to as DumpsterStatus,
  });

  if (error) {
    // Map the raise errcodes from set_dumpster_status to friendly messages.
    const map: Record<string, string> = {
      "42501": "You do not have permission to change dumpster status.",
      "23514": `That status change isn't allowed for this unit.`,
      P0002: "That dumpster no longer exists.",
    };
    throw new DumpsterMutationError(
      map[error.code ?? ""] ?? error.message,
      error.code ?? "rpc_failed",
    );
  }
  return data as DumpsterRow;
}

/** Maintenance override — always permitted from any state. */
export function markOutOfService(id: string): Promise<DumpsterRow> {
  return changeDumpsterStatus(id, "out_of_service");
}

/** Back from the shop. The state machine only allows -> available. */
export function returnToService(id: string): Promise<DumpsterRow> {
  return changeDumpsterStatus(id, "available");
}
