import type { DumpsterStatus, DumpsterSize } from "./state-machine";

export interface DumpsterRow {
  id: string;
  unit_number: string;
  size: DumpsterSize;
  status: DumpsterStatus;
  condition_notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A fleet-board tile: the row plus a derived day counter. */
export interface FleetUnit extends DumpsterRow {
  /** Whole days since the unit entered its current status (from status_log). */
  daysInStatus: number | null;
}

export interface StatusLogEntry {
  id: string;
  old_status: string | null;
  new_status: string;
  changed_by: string | null;
  changed_at: string;
}

export interface FleetSummary {
  total: number;
  byStatus: Record<DumpsterStatus, number>;
  bySize: Array<{
    size: DumpsterSize;
    total: number;
    available: number;
  }>;
}

export interface DumpsterDetail {
  unit: FleetUnit;
  history: StatusLogEntry[];
}
