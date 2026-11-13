/**
 * US phone key for SMS opt-outs: digits only; 10 digits, or 11 starting with
 * 1 -> the last 10; anything else null. Mirrors public._sms_phone_key
 * (migration 20261113000000); scripts/probe-sms-opt-outs.mjs and
 * phone-key.test.ts hold the same table of cases.
 */
export function smsPhoneKey(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/[^0-9]/g, "");
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return null;
}
