import "server-only";
import { createClient } from "@/lib/supabase/server";
import { assertStaff } from "@/lib/auth/requireStaff";
import {
  CANDIDATE_LIMIT,
  distinctAddresses,
  escapeLike,
  phoneLikePattern,
  phoneMatches,
  rankHits,
  searchMode,
  type CustomerHit,
  type PickedCustomer,
} from "./search-shared";

/**
 * Staff customer search for /bookings/new. Staff session only (never
 * service_role): assertStaff() runs before any query, because RLS alone would
 * still show a driver the customers on their own jobs.
 *
 * Errors carry a code, never the search term or any customer data, so callers
 * can log them safely.
 */

export class CustomerSearchError extends Error {
  constructor(readonly code: string) {
    super(`customer search failed (${code})`);
    this.name = "CustomerSearchError";
  }
}

const CUSTOMER_COLUMNS = "id, full_name, phone, email, company_name, sms_consent";

type Row = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  sms_consent: boolean;
};

export async function searchCustomers(rawTerm: string): Promise<CustomerHit[]> {
  await assertStaff();
  const mode = searchMode(rawTerm);
  if (!mode.name && !mode.digits) return [];
  const supabase = createClient();

  const [byName, byPhone] = await Promise.all([
    mode.name
      ? supabase
          .from("customers")
          .select(CUSTOMER_COLUMNS)
          .ilike("full_name", `%${escapeLike(mode.name)}%`)
          .order("full_name", { ascending: true })
          .limit(CANDIDATE_LIMIT)
      : Promise.resolve({ data: [] as Row[], error: null }),
    mode.digits
      ? supabase.from("customers").select(CUSTOMER_COLUMNS).ilike("phone", phoneLikePattern(mode.digits)).limit(CANDIDATE_LIMIT)
      : Promise.resolve({ data: [] as Row[], error: null }),
  ]);
  if (byName.error) throw new CustomerSearchError(`name_${byName.error.code ?? "read"}`);
  if (byPhone.error) throw new CustomerSearchError(`phone_${byPhone.error.code ?? "read"}`);

  const phoneHits = ((byPhone.data ?? []) as Row[]).filter((r) => phoneMatches(r.phone, mode.digits ?? ""));
  const top = rankHits(phoneHits, (byName.data ?? []) as Row[], rawTerm);
  if (top.length === 0) return [];

  const { data: counts, error: cErr } = await supabase
    .from("bookings")
    .select("customer_id")
    .in(
      "customer_id",
      top.map((r) => r.id),
    );
  if (cErr) throw new CustomerSearchError(`counts_${cErr.code ?? "read"}`);
  const n = new Map<string, number>();
  for (const b of (counts ?? []) as Array<{ customer_id: string }>) n.set(b.customer_id, (n.get(b.customer_id) ?? 0) + 1);

  return top.map((r) => ({
    id: r.id,
    name: r.full_name,
    phone: r.phone,
    company: r.company_name,
    bookings: n.get(r.id) ?? 0,
  }));
}

/** Everything the form needs after staff pick a customer. Never fills anything by itself. */
export async function pickCustomer(id: string): Promise<PickedCustomer | null> {
  await assertStaff();
  const supabase = createClient();
  const { data: c, error } = await supabase.from("customers").select(CUSTOMER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new CustomerSearchError(`pick_${error.code ?? "read"}`);
  if (!c) return null;
  const row = c as Row;

  const [addr, count, consent] = await Promise.all([
    supabase
      .from("bookings")
      .select("delivery_address, delivery_date")
      .eq("customer_id", id)
      .order("delivery_date", { ascending: false })
      .limit(20),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("customer_id", id),
    supabase
      .from("consent_records")
      .select("granted, source, recorded_at")
      .eq("customer_id", id)
      .order("recorded_at", { ascending: false })
      .limit(1),
  ]);
  if (addr.error) throw new CustomerSearchError(`addresses_${addr.error.code ?? "read"}`);
  if (count.error) throw new CustomerSearchError(`count_${count.error.code ?? "read"}`);
  if (consent.error) throw new CustomerSearchError(`consent_${consent.error.code ?? "read"}`);

  const last = ((consent.data ?? []) as Array<{ granted: boolean; source: string; recorded_at: string }>)[0];
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    company: row.company_name,
    bookings: count.count ?? 0,
    addresses: distinctAddresses(((addr.data ?? []) as Array<{ delivery_address: string }>).map((b) => b.delivery_address)),
    consent: {
      onFile: row.sms_consent === true,
      last: last ? { granted: last.granted, source: last.source, recordedAt: last.recorded_at } : null,
    },
  };
}

/**
 * Another customer already using this email (case-insensitive exact match),
 * other than the picked one. Returns the name only.
 */
export async function otherCustomerWithEmail(email: string, pickedId: string): Promise<string | null> {
  await assertStaff();
  const e = email.trim();
  if (!e) return null;
  const supabase = createClient();
  const { data, error } = await supabase
    .from("customers")
    .select("full_name")
    .ilike("email", escapeLike(e))
    .neq("id", pickedId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new CustomerSearchError(`email_${error.code ?? "read"}`);
  return ((data ?? []) as Array<{ full_name: string }>)[0]?.full_name ?? null;
}
