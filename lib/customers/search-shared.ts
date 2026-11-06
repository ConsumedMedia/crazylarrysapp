/**
 * Customer search for staff bookings: the pure parts (no I/O), shared by the
 * server library, the form and the tests.
 *
 * Phones are stored in several formats (614-555-0142, 6145550142,
 * +1 (614) 555-0142), so matching is on digits: a full number compares the
 * last 10 digits; a partial one must appear as a run of digits.
 */

export const SEARCH_LIMIT = 8;
/** Rows fetched per query before the exact digit filter and ranking. */
export const CANDIDATE_LIMIT = 50;
export const MIN_NAME_CHARS = 2;
export const MIN_PHONE_DIGITS = 3;
export const MAX_TERM_LENGTH = 100;

export interface CustomerHit {
  id: string;
  name: string;
  phone: string | null;
  company: string | null;
  bookings: number;
}

export interface AddressOption {
  /** As stored on the booking. */
  label: string;
  /** null = can't be split into street/city/state/ZIP: shown greyed, "type it". */
  parts: { street: string; city: string; state: string; zip: string } | null;
}

export interface PickedCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  bookings: number;
  addresses: AddressOption[];
  consent: {
    /** customers.sms_consent: the answer the next booking would keep or change. */
    onFile: boolean;
    /** Latest consent_records row, if any. */
    last: { granted: boolean; source: string; recordedAt: string } | null;
  };
}

export const digitsOf = (s: string | null | undefined): string => String(s ?? "").replace(/\D/g, "");
export const last10 = (s: string | null | undefined): string => digitsOf(s).slice(-10);

/** Letters left after removing digits and phone punctuation. */
const nameCharsOf = (term: string) => term.replace(/[\d\s()+\-.]/g, "");

/** Which searches a term triggers. */
export function searchMode(raw: string): { name: string | null; digits: string | null } {
  const term = raw.trim().slice(0, MAX_TERM_LENGTH);
  const d = digitsOf(term);
  return {
    name: nameCharsOf(term).length >= MIN_NAME_CHARS ? term : null,
    digits: d.length >= MIN_PHONE_DIGITS ? d : null,
  };
}

/** Escape LIKE wildcards so a typed % or _ matches itself. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * ILIKE pattern for a phone prefilter: the typed digits (last 10) in order with
 * anything between them, so every stored format matches. The exact rule is
 * applied afterwards by phoneMatches.
 */
export const phoneLikePattern = (typedDigits: string): string =>
  `%${typedDigits.slice(-10).split("").join("%")}%`;

/** Exact rule: 10+ typed digits compare the last 10; fewer must appear as a run. */
export function phoneMatches(stored: string | null, typedDigits: string): boolean {
  if (!stored || !typedDigits) return false;
  return typedDigits.length >= 10 ? last10(stored) === typedDigits.slice(-10) : digitsOf(stored).includes(typedDigits);
}

const ADDRESS = /^(.+), ([^,]+), ([A-Z]{2}) (\d{5}(?:-\d{4})?)$/;

/** Split "street, city, ST 12345" (how normalizeBookingInput builds it) back into parts. */
export function parseAddress(stored: string): AddressOption["parts"] {
  const m = stored.trim().match(ADDRESS);
  return m ? { street: m[1], city: m[2], state: m[3], zip: m[4] } : null;
}

/** Newest-first booking addresses -> up to `n` distinct options. */
export function distinctAddresses(newestFirst: string[], n = 3): AddressOption[] {
  const seen = new Set<string>();
  const out: AddressOption[] = [];
  for (const a of newestFirst) {
    const key = a.trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ label: a.trim(), parts: parseAddress(a) });
    if (out.length === n) break;
  }
  return out;
}

/** Phone hits first, then name hits; names starting with the term before the rest; deduped; at most 8. */
export function rankHits<T extends { id: string; full_name: string }>(phoneHits: T[], nameHits: T[], term: string): T[] {
  const t = term.trim().toLowerCase();
  const byName = [...nameHits].sort((a, b) => {
    const pa = a.full_name.toLowerCase().startsWith(t) ? 0 : 1;
    const pb = b.full_name.toLowerCase().startsWith(t) ? 0 : 1;
    return pa - pb || a.full_name.localeCompare(b.full_name);
  });
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...phoneHits, ...byName]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length === SEARCH_LIMIT) break;
  }
  return out;
}

/** Last 4 digits only, for warnings ("…0142"). */
export const phoneTail = (s: string | null | undefined): string => {
  const d = digitsOf(s);
  return d ? `…${d.slice(-4)}` : "none";
};
