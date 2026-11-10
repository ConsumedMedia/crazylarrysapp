/**
 * Reserved, fictional contacts that must never be sent to: the seed and test
 * data are full of them, and once the test variables (CL_NOTIFICATIONS_TEST_PHONE
 * / _EMAIL / _TO) are cleared at go-live any that are still in the database
 * would be sent to for real.
 *
 *  - email: example.com / example.net / example.org and their subdomains
 *    (RFC 2606 documentation domains)
 *  - phone: NXX-555-0100 through 555-0199 in any US area code (the range
 *    set aside for fiction)
 *
 * Pure — sendEmail / sendSms call these before the provider call, for the
 * intended recipient, and test-mode.ts for every redirect target.
 */
import { toE164US } from "./phone";

const RESERVED_EMAIL_DOMAIN = /(^|\.)example\.(com|net|org)$/i;

export function isReservedEmail(address: string | null | undefined): boolean {
  const at = (address ?? "").trim().lastIndexOf("@");
  if (at < 0) return false;
  return RESERVED_EMAIL_DOMAIN.test((address as string).trim().slice(at + 1));
}

export function isReservedPhone(raw: string | null | undefined): boolean {
  const e164 = toE164US(raw);
  return !!e164 && /^\+1\d{3}55501\d{2}$/.test(e164);
}
