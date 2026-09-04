import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/auth/requireStaff";

export interface CustomerListRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  booking_count: number;
  is_registered: boolean;
}

export interface CustomerDetail {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  is_registered: boolean;
  created_at: string;
  bookings: Array<{
    id: string;
    size_requested: string;
    delivery_date: string;
    status: string;
    payment_status: string;
    total: number;
  }>;
}

/** Searchable staff directory. `q` matches name / email / phone / company. */
export async function listCustomers(q?: string): Promise<CustomerListRow[]> {
  await requireStaff();
  const supabase = createClient();

  let query = supabase
    .from("customers")
    .select("id, full_name, email, phone, company_name, profile_id, bookings(id)")
    .order("full_name", { ascending: true })
    .limit(200);

  const term = q?.trim();
  if (term) {
    // PostgREST's .or() uses "," and "()" as syntax — strip them from the
    // search term so a name like "Smith, John" can't split into bogus clauses.
    const esc = term.replace(/[,()]/g, " ").replace(/[%_]/g, (c) => `\\${c}`);
    query = query.or(
      `full_name.ilike.%${esc}%,email.ilike.%${esc}%,phone.ilike.%${esc}%,company_name.ilike.%${esc}%`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`listCustomers: ${error.message}`);

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    full_name: r.full_name as string,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    company_name: (r.company_name as string | null) ?? null,
    booking_count: Array.isArray(r.bookings) ? r.bookings.length : 0,
    is_registered: !!r.profile_id,
  }));
}

export async function getCustomerDetail(id: string): Promise<CustomerDetail | null> {
  await requireStaff();
  const supabase = createClient();

  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, full_name, email, phone, company_name, profile_id, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getCustomerDetail: ${error.message}`);
  if (!customer) return null;

  const { data: bookings } = await supabase
    .from("bookings")
    .select("id, size_requested, delivery_date, status, payment_status, total")
    .eq("customer_id", id)
    .order("delivery_date", { ascending: false });

  return {
    id: customer.id as string,
    full_name: customer.full_name as string,
    email: (customer.email as string | null) ?? null,
    phone: (customer.phone as string | null) ?? null,
    company_name: (customer.company_name as string | null) ?? null,
    is_registered: !!customer.profile_id,
    created_at: customer.created_at as string,
    bookings: (bookings ?? []).map((b: Record<string, unknown>) => ({
      id: b.id as string,
      size_requested: b.size_requested as string,
      delivery_date: b.delivery_date as string,
      status: b.status as string,
      payment_status: b.payment_status as string,
      total: Number(b.total),
    })),
  };
}
