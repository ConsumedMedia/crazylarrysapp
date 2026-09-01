import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";
import {
  DUMPSTER_STATUSES,
  DUMPSTER_SIZES,
  type DumpsterStatus,
} from "./state-machine";
import type {
  DumpsterRow,
  FleetUnit,
  FleetSummary,
  DumpsterDetail,
  StatusLogEntry,
} from "./types";

function daysBetween(iso: string, now = Date.now()): number {
  const ms = now - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Every unit with its current status and a derived "days in status" counter.
 *
 * The counter comes from the most recent status_log row that moved the unit
 * *into* its current status. Once bookings exist this can switch to a
 * booking-derived "day N of M"; the tile component only needs the number.
 */
export async function listFleet(): Promise<FleetUnit[]> {
  await requireStaff();
  const supabase = createClient();

  const { data: units, error } = await supabase
    .from("dumpsters")
    .select("id, unit_number, size, status, condition_notes, created_at, updated_at")
    .order("unit_number", { ascending: true });

  if (error) throw new Error(`listFleet: ${error.message}`);
  const rows = (units ?? []) as DumpsterRow[];
  if (rows.length === 0) return [];

  const { data: logs, error: logErr } = await supabase
    .from("status_log")
    .select("entity_id, new_status, changed_at")
    .eq("entity_type", "dumpster")
    .in(
      "entity_id",
      rows.map((r) => r.id),
    )
    .order("changed_at", { ascending: false });

  if (logErr) throw new Error(`listFleet(logs): ${logErr.message}`);

  // Logs are DESC by changed_at; the first row per unit is the transition into
  // its current status (every status change is logged, so this holds).
  const enteredAt = new Map<string, string>();
  for (const log of (logs ?? []) as Array<{
    entity_id: string;
    new_status: string;
    changed_at: string;
  }>) {
    if (!enteredAt.has(log.entity_id)) {
      enteredAt.set(log.entity_id, log.changed_at);
    }
  }

  return rows.map((r) => {
    const since = enteredAt.get(r.id);
    return {
      ...r,
      daysInStatus: since ? daysBetween(since) : null,
    };
  });
}

export async function fleetSummary(): Promise<FleetSummary> {
  const fleet = await listFleet();

  const byStatus = Object.fromEntries(
    DUMPSTER_STATUSES.map((s) => [s, 0]),
  ) as Record<DumpsterStatus, number>;
  for (const u of fleet) byStatus[u.status] += 1;

  const bySize = DUMPSTER_SIZES.map((size) => {
    const inSize = fleet.filter((u) => u.size === size);
    return {
      size,
      total: inSize.length,
      available: inSize.filter((u) => u.status === "available").length,
    };
  });

  return { total: fleet.length, byStatus, bySize };
}

export async function getDumpster(id: string): Promise<DumpsterDetail | null> {
  await requireStaff();
  const supabase = createClient();

  const { data: row, error } = await supabase
    .from("dumpsters")
    .select("id, unit_number, size, status, condition_notes, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`getDumpster: ${error.message}`);
  if (!row) return null;
  const unitRow = row as DumpsterRow;

  const { data: history, error: histErr } = await supabase
    .from("status_log")
    .select("id, old_status, new_status, changed_by, changed_at")
    .eq("entity_type", "dumpster")
    .eq("entity_id", id)
    .order("changed_at", { ascending: false })
    .limit(20);

  if (histErr) throw new Error(`getDumpster(history): ${histErr.message}`);

  const rows = (history ?? []) as StatusLogEntry[];
  const enteredCurrent = rows.find((h) => h.new_status === unitRow.status);

  return {
    unit: {
      ...unitRow,
      daysInStatus: enteredCurrent
        ? daysBetween(enteredCurrent.changed_at)
        : null,
    },
    history: rows,
  };
}

/** Look up a unit id by its unit_number (used for ?sel=CL-127 URLs). */
export async function getDumpsterByUnitNumber(
  unitNumber: string,
): Promise<DumpsterDetail | null> {
  await requireStaff();
  const supabase = createClient();
  const { data, error } = await supabase
    .from("dumpsters")
    .select("id")
    .eq("unit_number", unitNumber.toUpperCase())
    .maybeSingle();
  if (error) throw new Error(`getDumpsterByUnitNumber: ${error.message}`);
  if (!data) return null;
  return getDumpster((data as { id: string }).id);
}
