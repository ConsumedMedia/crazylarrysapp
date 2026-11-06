/**
 * The /bookings/new customer autofill: the rules, kept pure so they can be
 * tested without a browser.
 *
 *  - Picking fills name, phone, email and company. Never an address, and the
 *    texts box is always reset to unticked (staff ask again on every call).
 *  - An address fills only when staff click one of the offered addresses.
 *  - Editing a picked customer's details updates that customer at booking
 *    time (_create_booking_core: name replaced, phone/email/company replaced
 *    when given), so every difference is spelled out before Book.
 */
import { digitsOf, phoneTail, searchMode, type AddressOption, type PickedCustomer } from "./search-shared";

export interface ContactFields {
  name: string;
  phone: string;
  email: string;
  company: string;
}

/** What a pick puts in the form. Deliberately no address and texts unticked. */
export function fillFromPick(p: PickedCustomer): ContactFields & { smsConsent: false } {
  return {
    name: p.name,
    phone: p.phone ?? "",
    email: p.email ?? "",
    company: p.company ?? "",
    smsConsent: false,
  };
}

/** An offered address only fills when it can be split; greyed ones return null. */
export function fillAddress(o: AddressOption): { street: string; city: string; state: string; zip: string } | null {
  return o.parts ? { ...o.parts } : null;
}

const SOURCE: Record<string, string> = { phone_verbal: "by phone", pay_page: "on the pay page" };

export function consentOnFileText(c: PickedCustomer["consent"]): string {
  if (!c.onFile) return "On file: no texts";
  if (c.last?.granted) {
    const when = new Date(c.last.recordedAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "America/New_York",
    });
    return `On file: agreed to texts (${SOURCE[c.last.source] ?? c.last.source}, ${when})`;
  }
  return "On file: agreed to texts";
}

/** Plain-words list of what booking will change on the picked customer. */
export function editWarnings(p: PickedCustomer, v: ContactFields, otherEmailOwner: string | null): string[] {
  const out: string[] = [];
  if (v.name.trim() && v.name.trim() !== p.name.trim()) out.push("Booking will update this customer's name on file.");
  const was = digitsOf(p.phone);
  const now = digitsOf(v.phone);
  if (now && now !== was) out.push(`Booking will update this customer's phone on file (${phoneTail(p.phone)} → ${phoneTail(v.phone)}).`);
  if (!now && was) out.push(`Phone left blank: the phone on file (${phoneTail(p.phone)}) stays.`);
  const e = v.email.trim().toLowerCase();
  if (e && e !== (p.email ?? "").trim().toLowerCase()) {
    out.push("Booking will update this customer's email on file.");
    if (otherEmailOwner) out.push(`That email already belongs to another customer: ${otherEmailOwner}.`);
  }
  if (v.company.trim() && v.company.trim() !== (p.company ?? "").trim()) out.push("Booking will update this customer's company on file.");
  return out;
}

/** Should typing this trigger a search? (Same thresholds as the server.) */
export const searchable = (term: string): boolean => {
  const m = searchMode(term);
  return !!(m.name || m.digits);
};

export type SearchState<H> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "results"; hits: H[] }
  | { status: "empty" }
  | { status: "error" };

/**
 * Debounced search with stale-reply protection: only the reply to the most
 * recent request is ever shown. No React; driven by `type(term)`.
 */
export function createSearchController<H>(opts: {
  run: (term: string) => Promise<{ ok: true; hits: H[] } | { ok: false }>;
  onState: (s: SearchState<H>) => void;
  delayMs?: number;
}) {
  const delay = opts.delayMs ?? 250;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    type(term: string) {
      clear();
      const mine = ++seq;
      if (!searchable(term)) {
        opts.onState({ status: "idle" });
        return;
      }
      timer = setTimeout(() => {
        opts.onState({ status: "loading" });
        opts
          .run(term)
          .then((r) => {
            if (mine !== seq) return;
            opts.onState(!r.ok ? { status: "error" } : r.hits.length ? { status: "results", hits: r.hits } : { status: "empty" });
          })
          .catch(() => {
            if (mine === seq) opts.onState({ status: "error" });
          });
      }, delay);
    },
    cancel() {
      clear();
      seq++;
    },
  };
}
