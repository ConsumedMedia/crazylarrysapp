"use server";

import { NotAuthorizedError } from "@/lib/auth/requireStaff";
import {
  CustomerSearchError,
  otherCustomerWithEmail,
  pickCustomer,
  searchCustomers,
} from "@/lib/customers/search";
import { MAX_TERM_LENGTH, type CustomerHit, type PickedCustomer } from "@/lib/customers/search-shared";

/**
 * Read-only server actions behind the /bookings/new customer autofill. Staff
 * only (the library checks before any query). On failure the server log gets
 * a short code — never the search term, an email, or any customer data — and
 * the form falls back to typing the details.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function logFailure(action: string, e: unknown) {
  const code =
    e instanceof CustomerSearchError ? e.code : e instanceof NotAuthorizedError ? "not_staff" : "unexpected";
  console.error(`[customer search] ${action} failed: ${code}`);
}

export async function searchCustomersAction(
  term: string,
): Promise<{ ok: true; hits: CustomerHit[] } | { ok: false }> {
  try {
    return { ok: true, hits: await searchCustomers(String(term ?? "").slice(0, MAX_TERM_LENGTH)) };
  } catch (e) {
    logFailure("search", e);
    return { ok: false };
  }
}

export async function pickCustomerAction(
  id: string,
): Promise<{ ok: true; customer: PickedCustomer | null } | { ok: false }> {
  if (!UUID.test(String(id ?? ""))) return { ok: false };
  try {
    return { ok: true, customer: await pickCustomer(id) };
  } catch (e) {
    logFailure("pick", e);
    return { ok: false };
  }
}

/** "This email belongs to <name>": name only, or null. */
export async function emailOwnerAction(
  email: string,
  pickedId: string,
): Promise<{ ok: true; name: string | null } | { ok: false }> {
  if (!UUID.test(String(pickedId ?? ""))) return { ok: false };
  const e = String(email ?? "").trim();
  if (!e || e.length > 254 || !e.includes("@")) return { ok: true, name: null };
  try {
    return { ok: true, name: await otherCustomerWithEmail(e, pickedId) };
  } catch (err) {
    logFailure("email", err);
    return { ok: false };
  }
}
