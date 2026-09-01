/**
 * Dumpster status state machine — UI MIRROR ONLY.
 *
 * The authoritative enforcer is the Postgres function `set_dumpster_status`
 * (see supabase/migrations/20260901020000_dumpster_status_engine.sql). This
 * module exists so the can-detail panel can render the right quick-action
 * buttons without a round trip. If this drifts from the DB, the RPC still
 * rejects the illegal transition — the UI just shows a button that errors.
 *
 * Keep `ALLOWED_TRANSITIONS` in lockstep with `dumpster_transition_allowed`.
 * `state-machine.test.ts` locks the intended matrix.
 */

export const DUMPSTER_STATUSES = [
  "available",
  "reserved",
  "deployed",
  "overdue",
  "out_of_service",
] as const;

export type DumpsterStatus = (typeof DUMPSTER_STATUSES)[number];

export const DUMPSTER_SIZES = ["10yd", "15yd", "20yd"] as const;
export type DumpsterSize = (typeof DUMPSTER_SIZES)[number];

/** Normal lifecycle edges only. out_of_service is handled specially below. */
const LIFECYCLE: Record<DumpsterStatus, DumpsterStatus[]> = {
  available: ["reserved"],
  reserved: ["deployed", "available"],
  deployed: ["overdue", "available"],
  overdue: ["available"],
  out_of_service: ["available"], // back from the shop, only to available
};

/**
 * All statuses reachable from `from` in one step, including the
 * "* -> out_of_service" maintenance override.
 */
export function nextStatuses(from: DumpsterStatus): DumpsterStatus[] {
  const set = new Set<DumpsterStatus>(LIFECYCLE[from]);
  if (from !== "out_of_service") set.add("out_of_service");
  set.delete(from);
  return DUMPSTER_STATUSES.filter((s) => set.has(s));
}

export const ALLOWED_TRANSITIONS: Record<DumpsterStatus, DumpsterStatus[]> =
  Object.fromEntries(
    DUMPSTER_STATUSES.map((s) => [s, nextStatuses(s)]),
  ) as Record<DumpsterStatus, DumpsterStatus[]>;

export function canTransition(
  from: DumpsterStatus,
  to: DumpsterStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isDumpsterStatus(v: unknown): v is DumpsterStatus {
  return (
    typeof v === "string" &&
    (DUMPSTER_STATUSES as readonly string[]).includes(v)
  );
}

export function isDumpsterSize(v: unknown): v is DumpsterSize {
  return (
    typeof v === "string" && (DUMPSTER_SIZES as readonly string[]).includes(v)
  );
}

/** Design-system status coding (DESIGN-SYSTEM.md §Status Coding). */
export const STATUS_META: Record<
  DumpsterStatus,
  { label: string; brand: "teal" | "purple" | "pink" | "orange" | "gray-st" }
> = {
  available: { label: "Available", brand: "teal" },
  reserved: { label: "Reserved", brand: "purple" },
  deployed: { label: "Deployed", brand: "pink" },
  overdue: { label: "Overdue", brand: "orange" },
  out_of_service: { label: "Out of service", brand: "gray-st" },
};
