import type { DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { BookingStatus, DocusignStatus } from "./state-machine";

export type { DumpsterSize, BookingStatus, DocusignStatus };

export interface BookingRow {
  id: string;
  customer_id: string;
  dumpster_id: string | null;
  size_requested: DumpsterSize;
  delivery_address: string;
  delivery_date: string;
  pickup_date: string | null;
  status: BookingStatus;
  placement_notes: string | null;
  debris_type: string | null;
  subtotal: number;
  tax: number;
  total: number;
  quickbooks_invoice_id: string | null;
  docusign_status: DocusignStatus;
  created_at: string;
  updated_at: string;
}

export interface CustomerRow {
  id: string;
  profile_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
}

export interface JobRow {
  id: string;
  booking_id: string;
  type: "delivery" | "pickup";
  driver_id: string | null;
  scheduled_date: string;
  status: "unassigned" | "assigned" | "completed" | "cancelled";
  route_order: number | null;
  completed_at: string | null;
}

export interface BookingDetail {
  booking: BookingRow;
  customer: CustomerRow;
  jobs: JobRow[];
  history: Array<{
    id: string;
    entity_type: string;
    old_status: string | null;
    new_status: string;
    changed_at: string;
  }>;
}

export interface CreateBookingInput {
  size: DumpsterSize;
  deliveryDate: string; // yyyy-mm-dd
  rentalDays?: number;
  street: string;
  city: string;
  state: string;
  zip: string;
  placementNotes?: string;
  debrisType?: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  companyName?: string;
}
