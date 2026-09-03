/**
 * Normalize a stored phone string to E.164 for Quo (which requires it).
 * Stored numbers are typically bare 10-digit US ("6147692089") or already
 * "+1..."; anything we can't confidently map to a US E.164 number returns null
 * and the caller logs the send as failed rather than guessing.
 */
export function toE164US(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Already-plus-prefixed non-US or an odd length — don't fabricate.
  if (raw.trim().startsWith("+") && digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}

/** Display form for logs / UI: +16147692089 -> (614) 769-2089 */
export function prettyPhone(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
