"use client";

import type { AddressOption, CustomerHit, PickedCustomer } from "@/lib/customers/search-shared";
import type { SearchState } from "@/lib/customers/autofill";
import { consentOnFileText } from "@/lib/customers/autofill";

/**
 * Presentational pieces of the /bookings/new customer autofill. Pure (props
 * in, markup out) so every state can be rendered in tests; the state lives in
 * BookingFormLayout.
 */

export const RESULTS_ID = "customer-search-results";

export function SearchResults({
  state,
  activeIndex,
  onPick,
}: {
  state: SearchState<CustomerHit>;
  activeIndex: number;
  onPick: (hit: CustomerHit) => void;
}) {
  if (state.status === "idle") return null;
  if (state.status === "loading") return <p className="text-[12px] text-ink-3">Searching…</p>;
  if (state.status === "empty") return <p className="text-[12px] text-ink-2">No match — this will be a new customer.</p>;
  if (state.status === "error")
    return <p className="text-[12px] font-semibold text-orange-tint-ink">Search isn&apos;t available — type the details.</p>;
  return (
    <ul id={RESULTS_ID} role="listbox" className="flex flex-col border-2 border-line-strong bg-bg" data-testid="customer-results">
      {state.hits.map((h, i) => (
        <li
          key={h.id}
          id={`${RESULTS_ID}-${i}`}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus; pick before the input blurs
            onPick(h);
          }}
          className={`cursor-pointer px-2.5 py-1.5 text-[12px] ${i === activeIndex ? "bg-tint" : "hover:bg-tint"}`}
        >
          <span className="font-extrabold">{h.name}</span>
          {h.phone && <span className="cl-nums text-ink-2"> · {h.phone}</span>}
          {h.company && <span className="text-ink-2"> · {h.company}</span>}
          <span className="text-ink-3">
            {" "}
            · {h.bookings} booking{h.bookings === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PickedBanner({ picked, onClear }: { picked: PickedCustomer; onClear: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-l-4 border-teal bg-teal-tint px-2.5 py-1.5 text-[12px] text-teal-tint-ink" data-testid="picked-customer">
      <span className="font-extrabold">Existing customer</span>
      <span>
        · {picked.bookings} booking{picked.bookings === 1 ? "" : "s"}
      </span>
      <button type="button" onClick={onClear} className="ml-auto font-extrabold underline">
        Not this customer
      </button>
    </div>
  );
}

export function AddressOptions({
  options,
  onUse,
  onNew,
}: {
  options: AddressOption[];
  onUse: (o: AddressOption) => void;
  onNew: () => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="address-options">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">Previous addresses</span>
      <div className="flex flex-wrap gap-2">
        {options.map((o) =>
          o.parts ? (
            <button
              key={o.label}
              type="button"
              onClick={() => onUse(o)}
              className="border-2 border-line px-2.5 py-1.5 text-left text-[12px] font-bold hover:border-ink"
            >
              {o.label}
            </button>
          ) : (
            <button
              key={o.label}
              type="button"
              disabled
              title="This address can't be split into street, city, state and ZIP"
              className="border-2 border-line px-2.5 py-1.5 text-left text-[12px] text-ink-3 opacity-60"
            >
              {o.label} — type it
            </button>
          ),
        )}
        <button type="button" onClick={onNew} className="border-2 border-line px-2.5 py-1.5 text-[12px] font-extrabold hover:border-ink">
          New address
        </button>
      </div>
    </div>
  );
}

export function ConsentOnFile({ consent }: { consent: PickedCustomer["consent"] }) {
  return (
    <p className="pl-6 text-[12px] font-semibold text-ink-2" data-testid="consent-on-file">
      {consentOnFileText(consent)}
    </p>
  );
}

export function EditWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 border-l-4 border-orange bg-orange-tint px-2.5 py-1.5 text-[12px] font-semibold text-orange-tint-ink" data-testid="edit-warnings">
      {warnings.map((w) => (
        <li key={w}>{w}</li>
      ))}
    </ul>
  );
}
