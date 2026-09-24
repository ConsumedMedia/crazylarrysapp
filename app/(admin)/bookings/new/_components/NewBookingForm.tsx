"use client";

import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { AvailabilityCalendar } from "@/app/(customer)/book/_components/AvailabilityCalendar";
import { DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import { rentalWindow } from "@/lib/availability/dates";
import { DUMPSTER_SIZES, type DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { PricingConfig } from "@/lib/bookings/pricing";
import { createStaffBookingAction, type BookingActionState } from "../../actions";

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

export function NewBookingForm({
  pricing,
  customer,
}: {
  pricing: PricingConfig;
  customer: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    companyName: string | null;
  } | null;
}) {
  const [state, action] = useFormState(createStaffBookingAction, init);
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
      {customer && <input type="hidden" name="customerId" value={customer.id} />}

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
          <Field label="Street">
            <input name="street" required className={inputCls} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <Field label="City">
              <input name="city" required className={inputCls} />
            </Field>
            <Field label="State">
              <input name="state" required defaultValue="OH" className={inputCls} />
            </Field>
            <Field label="ZIP">
              <input name="zip" required className={inputCls} />
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
        <Section title={customer ? "Customer (existing)" : "Customer"}>
          <Field label="Name">
            <input
              name="contactName"
              required
              defaultValue={customer?.fullName ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Phone">
            <input
              name="contactPhone"
              type="tel"
              defaultValue={customer?.phone ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Email — needed for a QuickBooks pay link">
            <input
              name="contactEmail"
              type="email"
              defaultValue={customer?.email ?? ""}
              className={inputCls}
            />
          </Field>
          <Field label="Company (optional)">
            <input
              name="companyName"
              defaultValue={customer?.companyName ?? ""}
              className={inputCls}
            />
          </Field>
          <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
            <input
              type="checkbox"
              name="smsConsent"
              className="mt-0.5 h-4 w-4 flex-none accent-teal"
            />
            <span>
              Customer agreed to automated text updates (confirmation,
              arrival, pickup). Ask on the call — leaving this unchecked turns
              texts off for this customer.
            </span>
          </label>
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
          <p className="text-[11px] text-ink-3">
            The customer gets the booking confirmation (email, and SMS only if
            they agreed) showing this amount as due.
          </p>
          {state.error && (
            <p className="text-[12px] font-semibold text-orange-tint-ink">{state.error}</p>
          )}
          <Submit disabled={!deliveryDate || !quote} />
        </Section>
      </div>
    </form>
  );
}
