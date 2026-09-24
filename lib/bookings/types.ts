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
  payment_status: "unpaid" | "paid" | "failed" | "refunded";
  docusign_status: DocusignStatus;
  driveway_fee_applied: boolean;
  driveway_fee_amount: number | null;
  driveway_fee_applied_by: string | null;
  driveway_fee_applied_at: string | null;
  driveway_fee_note: string | null;
  driveway_fee_qb_invoice_id: string | null;
  source: "online" | "staff";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceRow {
  id: string;
  booking_id: string;
  amount: number;
  status: string;
  qb_charge_id: string | null;
  qb_payment_id: string | null;
  qb_refund_id: string | null;
  refund_kind: "void" | "refund" | null;
  refunded_amount: number | null;
  refunded_at: string | null;
  sync_status: "pending" | "synced" | "error";
  quickbooks_invoice_id: string | null;
  paid_at: string | null;
  payment_method: "card" | "cash" | "check" | "qbo_invoice" | null;
  payment_reference: string | null;
  payment_note: string | null;
  recorded_by: string | null;
  qb_invoice_link: string | null;
  invoice_sent_to: string | null;
  invoice_sent_at: string | null;
  qb_balance: number | null;
  qb_checked_at: string | null;
  failure_reason: string | null;
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
  dumpsterUnitNumber: string | null;
  drivewayFeeStaffName: string | null;
  createdByName: string | null;
  paymentRecordedByName: string | null;
  customer: CustomerRow;
  invoice: InvoiceRow | null;
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
  smsConsent?: boolean;
}
