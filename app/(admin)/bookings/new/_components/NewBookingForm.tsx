"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { AvailabilityCalendar } from "@/app/(customer)/book/_components/AvailabilityCalendar";
import { DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import { rentalWindow } from "@/lib/availability/dates";
import { DUMPSTER_SIZES, type DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { PricingConfig } from "@/lib/bookings/pricing";
import { createStaffBookingAction, type BookingActionState } from "../../actions";
import { emailOwnerAction, pickCustomerAction, searchCustomersAction } from "../customer-actions";
import type { CustomerHit, PickedCustomer } from "@/lib/customers/search-shared";
import {
  createSearchController,
  editWarnings,
  fillAddress,
  fillFromPick,
  type SearchState,
} from "@/lib/customers/autofill";
import {
  AddressOptions,
  ConsentOnFile,
  EditWarnings,
  PickedBanner,
  RESULTS_ID,
  SearchResults,
} from "./CustomerAutofill";

const PLACEMENTS = ["Driveway", "Street", "Yard", "Other — see notes"];
const DEBRIS = [
  "Household junk",
  "Renovation debris",
  "Roofing",
  "Yard waste",
  "Other",
];

const init: BookingActionState = { ok: false };

const inputCls =
  "w-full border-2 border-line bg-bg px-2.5 py-2 text-[13px] text-ink";

function money(n: number) {
  return `$${n.toFixed(2)}`;
}
function fmtDate(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={disabled || pending}
      className="self-start bg-teal px-4 py-2.5 text-[13px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-60"
    >
      {pending ? "Creating…" : "Create booking (unpaid)"}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        {label}
      </span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
        {title}
      </div>
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

/** A customer the form starts with (?customer=<id>) — the same shape as a pick. */
export type FormCustomer = PickedCustomer;

/** What the submit area needs to decide whether it can submit. */
export interface FormReadiness {
  /** A delivery date is picked and the size has a price. */
  ready: boolean;
  /** The picked delivery date (yyyy-mm-dd), or null. The pay-link button checks it against the order cutoff. */
  deliveryDate: string | null;
  contactEmail: string;
  contactPhone: string;
  smsConsent: boolean;
}

/** Today's staff booking form (pay links off): creates the booking unpaid. */
export function NewBookingForm({
  pricing,
  customer,
}: {
  pricing: PricingConfig;
  customer: FormCustomer | null;
}) {
  const [state, action] = useFormState(createStaffBookingAction, init);
  return (
    <BookingFormLayout
      pricing={pricing}
      customer={customer}
      action={action}
      summaryNote={
        <p className="text-[11px] text-ink-3">
          The customer gets the booking confirmation (email, and SMS only if
          they agreed) showing this amount as due.
        </p>
      }
      renderSubmit={({ ready }) => (
        <>
          {state.error && (
            <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>
          )}
          <Submit disabled={!ready} />
        </>
      )}
    />
  );
}

/**
 * The form body shared by today's form and the pay-link form. Only the submit
 * area, the note under the summary and the line under the texts checkbox
 * differ, so with pay links off the markup is exactly what it was.
 */
export function BookingFormLayout({
  pricing,
  customer,
  action,
  summaryNote,
  consentScript,
  renderSubmit,
}: {
  pricing: PricingConfig;
  customer: FormCustomer | null;
  action: (formData: FormData) => void;
  summaryNote: React.ReactNode;
  consentScript?: React.ReactNode;
  renderSubmit: (r: FormReadiness) => React.ReactNode;
}) {
  // Contact and address fields are controlled so a pick (or an offered
  // address, on click) can fill them; they render exactly as before.
  const [picked, setPicked] = useState<PickedCustomer | null>(customer);
  const [contactName, setContactName] = useState(customer?.name ?? "");
  const [contactEmail, setContactEmail] = useState(customer?.email ?? "");
  const [contactPhone, setContactPhone] = useState(customer?.phone ?? "");
  const [companyName, setCompanyName] = useState(customer?.company ?? "");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateAbbr, setStateAbbr] = useState("OH");
  const [zip, setZip] = useState("");
  // The address fields hold an address offered for the picked customer, so
  // "Not this customer" must clear them. A hand-typed address stays.
  const [addressFromOffer, setAddressFromOffer] = useState(false);
  const [smsConsent, setSmsConsent] = useState(false);
  const [search, setSearch] = useState<SearchState<CustomerHit>>({ status: "idle" });
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pickError, setPickError] = useState(false);
  const [emailOwner, setEmailOwner] = useState<string | null>(null);

  const searcher = useRef<ReturnType<typeof createSearchController<CustomerHit>> | null>(null);
  useEffect(() => {
    searcher.current = createSearchController<CustomerHit>({
      run: searchCustomersAction,
      onState: (s) => {
        setSearch(s);
        setActiveIndex(-1);
      },
    });
    return () => searcher.current?.cancel();
  }, []);

  // A picked customer's email changed to another customer's: name that customer.
  const emailSeq = useRef(0);
  useEffect(() => {
    const e = contactEmail.trim().toLowerCase();
    const mine = ++emailSeq.current;
    if (!picked || !e.includes("@") || e === (picked.email ?? "").trim().toLowerCase()) {
      setEmailOwner(null);
      return;
    }
    const t = setTimeout(() => {
      emailOwnerAction(contactEmail, picked.id)
        .then((r) => {
          if (mine === emailSeq.current) setEmailOwner(r.ok ? r.name : null);
        })
        .catch(() => {
          if (mine === emailSeq.current) setEmailOwner(null);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [contactEmail, picked]);

  const typeToSearch = (term: string) => {
    if (picked) return; // a picked customer is edited, not searched for
    setPickError(false);
    searcher.current?.type(term);
  };

  const pick = async (hit: CustomerHit) => {
    searcher.current?.cancel();
    setSearch({ status: "idle" });
    const r = await pickCustomerAction(hit.id).catch(() => ({ ok: false as const }));
    if (!r.ok || !r.customer) {
      setPickError(true);
      return;
    }
    const f = fillFromPick(r.customer);
    setPicked(r.customer);
    setContactName(f.name);
    setContactPhone(f.phone);
    setContactEmail(f.email);
    setCompanyName(f.company);
    setSmsConsent(f.smsConsent);
  };

  // Nothing of the picked customer may survive: a leftover email would match
  // that customer again at booking time, and a ticked box would record consent
  // for whoever is booked next.
  const notThisCustomer = () => {
    searcher.current?.cancel();
    setSearch({ status: "idle" });
    setPickError(false);
    setPicked(null);
    setEmailOwner(null);
    setContactName("");
    setContactPhone("");
    setContactEmail("");
    setCompanyName("");
    setSmsConsent(false);
    if (addressFromOffer) {
      setStreet("");
      setCity("");
      setStateAbbr("OH");
      setZip("");
      setAddressFromOffer(false);
    }
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (search.status !== "results") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, search.hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      void pick(search.hits[activeIndex]);
    } else if (e.key === "Escape") {
      searcher.current?.cancel();
      setSearch({ status: "idle" });
    }
  };

  const open = search.status === "results";
  const comboProps = {
    autoComplete: "off",
    role: "combobox",
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": RESULTS_ID,
    ...(open && activeIndex >= 0 ? { "aria-activedescendant": `${RESULTS_ID}-${activeIndex}` } : {}),
    onKeyDown: onSearchKey,
  };
  const warnings = picked
    ? editWarnings(picked, { name: contactName, phone: contactPhone, email: contactEmail, company: companyName }, emailOwner)
    : [];

  const [size, setSize] = useState<DumpsterSize>("15yd");
  const [deliveryDate, setDeliveryDate] = useState<string | null>(null);

  const quote = useMemo(() => {
    const z = pricing.sizes.find((x) => x.size === size);
    if (!z || !z.is_active || z.base_price <= 0 || pricing.settings.tax_rate <= 0)
      return null;
    const subtotal = z.base_price;
    const tax = Math.round(subtotal * pricing.settings.tax_rate * 100) / 100;
    return { subtotal, tax, total: subtotal + tax };
  }, [size, pricing]);

  const pickupDate = deliveryDate
    ? rentalWindow(deliveryDate, DEFAULT_RENTAL_DAYS).at(-1)!
    : null;

  return (
    <form action={action} className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <input type="hidden" name="size" value={size} />
      <input type="hidden" name="deliveryDate" value={deliveryDate ?? ""} />
      {picked && <input type="hidden" name="customerId" value={picked.id} />}

      <div className="flex flex-col gap-4">
        <Section title="Size & delivery date">
          <div className="flex flex-wrap gap-2">
            {DUMPSTER_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSize(s);
                  setDeliveryDate(null); // availability differs per size
                }}
                className={`border-2 px-3 py-2 text-[12px] font-extrabold ${
                  s === size ? "border-ink bg-ink text-surface" : "border-line hover:border-ink"
                }`}
              >
                {s.replace("yd", " yard")}
              </button>
            ))}
          </div>
          <AvailabilityCalendar
            size={size}
            selectedDate={deliveryDate}
            onSelectDate={setDeliveryDate}
          />
          <p className="text-[11px] text-ink-3">
            Earliest delivery is tomorrow. Availability is re-checked when you
            submit, under the same lock as online checkout.
          </p>
        </Section>

        <Section title="Delivery address">
          {picked && (
            <AddressOptions
              options={picked.addresses}
              onUse={(o) => {
                const a = fillAddress(o);
                if (!a) return;
                setStreet(a.street);
                setCity(a.city);
                setStateAbbr(a.state);
                setZip(a.zip);
                setAddressFromOffer(true);
              }}
              onNew={() => {
                setStreet("");
                setCity("");
                setStateAbbr("OH");
                setZip("");
                setAddressFromOffer(false);
              }}
            />
          )}
          <Field label="Street">
            <input name="street" required value={street} onChange={(e) => setStreet(e.currentTarget.value)} className={inputCls} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <Field label="City">
              <input name="city" required value={city} onChange={(e) => setCity(e.currentTarget.value)} className={inputCls} />
            </Field>
            <Field label="State">
              <input name="state" required value={stateAbbr} onChange={(e) => setStateAbbr(e.currentTarget.value)} className={inputCls} />
            </Field>
            <Field label="ZIP">
              <input name="zip" required value={zip} onChange={(e) => setZip(e.currentTarget.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Placement">
              <select name="placement" className={inputCls} defaultValue={PLACEMENTS[0]}>
                {PLACEMENTS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Field label="Debris">
              <select name="debrisType" className={inputCls} defaultValue="">
                <option value="">—</option>
                {DEBRIS.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Notes for the driver">
            <input name="placementNotes" className={inputCls} />
          </Field>
        </Section>
      </div>

      <div className="flex flex-col gap-4">
        <Section title={picked ? "Customer (existing)" : "Customer"}>
          {picked && (
            <PickedBanner picked={picked} onClear={notThisCustomer} />
          )}
          <Field label="Name">
            <input
              name="contactName"
              required
              value={contactName}
              onChange={(e) => {
                setContactName(e.currentTarget.value);
                typeToSearch(e.currentTarget.value);
              }}
              {...comboProps}
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
            <input
              name="contactPhone"
              type="tel"
              value={contactPhone}
              onChange={(e) => {
                setContactPhone(e.currentTarget.value);
                typeToSearch(e.currentTarget.value);
              }}
              {...comboProps}
              className={inputCls}
            />
          </Field>
          <SearchResults state={search} activeIndex={activeIndex} onPick={(h) => void pick(h)} />
          {pickError && (
            <p className="text-[12px] font-semibold text-orange-tint-ink">Couldn&apos;t load that customer — type the details.</p>
          )}
          <Field label="Email — needed for a QuickBooks pay link">
            <input
              name="contactEmail"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.currentTarget.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Company (optional)">
            <input
              name="companyName"
              value={companyName}
              onChange={(e) => setCompanyName(e.currentTarget.value)}
              className={inputCls}
            />
          </Field>
          {picked && <EditWarnings warnings={warnings} />}
          <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
            <input
              type="checkbox"
              name="smsConsent"
              checked={smsConsent}
              onChange={(e) => setSmsConsent(e.currentTarget.checked)}
              className="mt-0.5 h-4 w-4 flex-none accent-teal"
            />
            <span>
              Customer agreed to automated text updates (confirmation,
              arrival, pickup). Ask on the call — leaving this unchecked turns
              texts off for this customer.
            </span>
          </label>
          {picked && <ConsentOnFile consent={picked.consent} />}
          {consentScript}
        </Section>

        <Section title="Summary">
          <div className="flex flex-col gap-1.5 text-[13px]">
            <div className="flex justify-between">
              <span className="text-ink-2">Size</span>
              <span className="font-bold">{size.replace("yd", " yd")} · {DEFAULT_RENTAL_DAYS} days</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-2">Delivery</span>
              <span className="font-bold">{deliveryDate ? fmtDate(deliveryDate) : "Pick a date"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-2">Pickup</span>
              <span className="font-bold">{pickupDate ? fmtDate(pickupDate) : "—"}</span>
            </div>
            {quote ? (
              <div className="mt-1 flex justify-between border-t-2 border-line-strong pt-2">
                <span className="text-ink-2">
                  Due ({money(quote.subtotal)} + {money(quote.tax)} tax)
                </span>
                <span className="cl-nums text-[16px] font-black">{money(quote.total)}</span>
              </div>
            ) : (
              <p className="text-[12px] font-semibold text-orange-tint-ink">
                Pricing isn&apos;t configured for this size — set rates in Settings.
              </p>
            )}
          </div>
          {summaryNote}
          {renderSubmit({ ready: !!deliveryDate && !!quote, deliveryDate, contactEmail, contactPhone, smsConsent })}
        </Section>
      </div>
    </form>
  );
}
