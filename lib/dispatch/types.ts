import type { DumpsterSize } from "@/lib/dumpsters/state-machine";

export type JobType = "delivery" | "pickup";
export type JobStatus = "unassigned" | "assigned" | "completed" | "cancelled";

export interface DispatchJob {
  id: string;
  type: JobType;
  status: JobStatus;
  scheduled_date: string;
  route_order: number | null;
  completed_at: string | null;
  driver_id: string | null;
  booking_id: string;
  // joined from booking
  size_requested: DumpsterSize;
  delivery_address: string;
  debris_type: string | null;
  placement_notes: string | null;
  job_tags: string[];
  job_tags_confirmed_at: string | null;
  booking_status: string;
  dumpster_id: string | null;
  dumpster_unit: string | null;
  // joined from customer
  customer_name: string;
  customer_phone: string | null;
  customer_company: string | null;
}

export interface DriverRow {
  id: string;
  profile_id: string;
  full_name: string;
  phone: string | null;
  vehicle_info: string | null;
  active: boolean;
  truck_id: string | null;
  truck_nickname: string | null;
  truck_status: string | null;
}

export interface AssignmentCheck {
  allowed: boolean;
  requires_override: boolean;
  truck_id: string | null;
  truck_nickname: string | null;
  blockers: Array<{
    kind: string;
    dimension?: string;
    match_value?: string;
    source_phrase?: string;
    detail?: string;
  }>;
  warnings: Array<{
    kind: string;
    dimension?: string;
    match_value?: string;
    source_phrase?: string;
    detail?: string;
  }>;
}
