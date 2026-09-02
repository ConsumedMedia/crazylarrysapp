"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AvailabilityCalendar } from "./AvailabilityCalendar";
import { AgreementModal } from "./AgreementModal";
import { createBookingAction } from "../actions";
import { DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import { rentalWindow } from "@/lib/availability/dates";
import { DUMPSTER_SIZES, type DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { PricingConfig } from "@/lib/bookings/pricing";

const SIZE_COPY: Record<
  DumpsterSize,
  { footprint: string; holds: string; best: string }
> = {
  "10yd": {
    footprint: "12 ft × 8 ft × 3.5 ft",
    holds: "~3 pickup loads",
    best: "One room gutted, a small roof, a garage cleanout.",
  },
  "15yd": {
    footprint: "16 ft × 8 ft × 4 ft",
    holds: "~4.5 pickup loads",
    best: "A whole kitchen, flooring for a house, deck teardown.",
  },
  "20yd": {
    footprint: "22 ft × 8 ft × 4.5 ft",
    holds: "~6 pickup loads",
    best: "Whole-house cleanout, additions, commercial jobs.",
  },
};

const PLACEMENTS = ["Driveway", "Street", "Yard", "Other — see notes"];
const DEBRIS = [
  "Household junk",
  "Renovation debris",
  "Roofing",
  "Yard waste",
  "Other",
];

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

const STEPS = ["Size", "Dates", "Details", "Review & pay"];

export function BookingWizard({
  pricing,
  docusignUrl,
}: {
  pricing: PricingConfig;
  docusignUrl: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [size, setSize] = useState<DumpsterSize | null>(null);
  const [deliveryDate, setDeliveryDate] = useState<string | null>(null);

  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [stateAbbr, setStateAbbr] = useState("OH");
  const [zip, setZip] = useState("");
  const [placement, setPlacement] = useState(PLACEMENTS[0]);
  const [driverNotes, setDriverNotes] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [debris, setDebris] = useState<string>("");

  const [agreementOpen, setAgreementOpen] = useState(false);
  const [agreementAck, setAgreementAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const quote = useMemo(() => {
    if (!size) return null;
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

  const detailsValid =
    street.trim() &&
    city.trim() &&
    stateAbbr.trim() &&
    zip.trim() &&
    contactName.trim() &&
    (contactEmail.trim() || contactPhone.trim());

  function submit() {
    if (!size || !deliveryDate) return;
    setError(null);
    startTransition(async () => {
      const res = await createBookingAction({
        size,
        deliveryDate,
        rentalDays: DEFAULT_RENTAL_DAYS,
        street,
        city,
        state: stateAbbr,
        zip,
        placementNotes: `Placement: ${placement}${driverNotes ? ` — ${driverNotes}` : ""}`,
        debrisType: debris || undefined,
        contactName,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined,
        companyName: companyName || undefined,
        agreementAcknowledged: agreementAck,
      });
      if (res.ok && res.bookingId) {
        router.push(`/book/confirmed/${res.bookingId}`);
      } else {
        setError(res.error ?? "Booking failed.");
      }
    });
  }

  return (
    <div className="flex flex-col">
      {/* Stepper */}
      <div className="flex border-y border-line">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "now" : "todo";
          return (
            <div
              key={label}
              className={`flex flex-1 items-center gap-2 border-b-4 px-1 py-2.5 ${
                state === "now"
                  ? "border-pink"
                  : state === "done"
                    ? "border-teal"
                    : "border-transparent"
              }`}
            >
              <span
                className={`grid h-5 w-5 flex-none place-items-center text-[11px] font-extrabold ${
                  state === "now"
                    ? "bg-pink text-white"
                    : state === "done"
                      ? "bg-teal text-white"
                      : "bg-tint text-ink-3"
                }`}
              >
                {n}
              </span>
              <span
                className={`truncate text-[11px] font-extrabold uppercase tracking-[0.1em] ${
                  state === "todo" ? "text-ink-3" : "text-ink"
                }`}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="py-6">
        {/* STEP 1 — SIZE */}
        {step === 1 && (
          <div className="flex flex-col gap-6">
            <div>
              <h1 className="text-[30px] font-black leading-none tracking-[-0.035em]">
                Pick a dumpster size.
              </h1>
              <p className="mt-2 text-[15px] text-ink-2">
                Every size includes five days on site, one ton of weight,
                delivery and haul-away.
              </p>
            </div>
            {!pricing.bookingReady && (
              <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[13px] font-semibold text-orange-tint-ink">
                Online booking is being set up. Please call the yard to reserve a
                can.
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-3">
              {DUMPSTER_SIZES.map((s) => {
                const z = pricing.sizes.find((x) => x.size === s);
                const priced = z && z.is_active && z.base_price > 0;
                return (
                  <div
                    key={s}
                    className="flex flex-col border-2 border-line-strong bg-surface"
                  >
                    <div className="bg-ink px-4 py-3.5 text-white">
                      <div className="text-[30px] font-black leading-none tracking-[-0.035em]">
                        {s.replace("yd", "")}
                        <span className="text-[13px] font-bold tracking-[0.06em]">
                          {" "}
                          YARD
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-1 flex-col gap-3 p-4">
                      <div className="text-[32px] font-black leading-none tracking-[-0.035em]">
                        {priced ? money(z!.base_price) : "Call"}
                        <span className="ml-1.5 text-[12px] font-bold text-ink-2">
                          flat · 5 days · 1 ton
                        </span>
                      </div>
                      <dl className="flex flex-col gap-1.5 border-t border-line pt-3 text-[13px]">
                        <div className="flex justify-between gap-2">
                          <dt className="text-ink-2">Footprint</dt>
                          <dd className="text-right font-bold">
                            {SIZE_COPY[s].footprint}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-ink-2">Holds about</dt>
                          <dd className="text-right font-bold">
                            {SIZE_COPY[s].holds}
                          </dd>
                        </div>
                      </dl>
                      <p
                        className="border-l-[3px] border-ink pl-2.5 text-[13px] text-ink-2"
                        style={{ borderColor: "var(--cl-line-strong)" }}
                      >
                        {SIZE_COPY[s].best}
                      </p>
                      <button
                        disabled={!pricing.bookingReady}
                        onClick={() => {
                          setSize(s);
                          setStep(2);
                        }}
                        className="mt-auto flex items-center justify-between bg-teal px-4 py-3 text-[14px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-50"
                      >
                        Check dates <span>→</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 2 — CALENDAR */}
        {step === 2 && size && (
          <div className="flex flex-col gap-5">
            <div>
              <h1 className="text-[30px] font-black leading-none tracking-[-0.035em]">
                When do you want it dropped?
              </h1>
              <p className="mt-2 text-[15px] text-ink-2">
                {size.replace("yd", " yard")}
                {quote && ` · ${money(quote.subtotal)} flat`} · five days on
                site. Grey days are booked out at this size.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
              <AvailabilityCalendar
                size={size}
                selectedDate={deliveryDate}
                onSelectDate={setDeliveryDate}
              />
              <div className="flex flex-col gap-4">
                {deliveryDate && (
                  <div className="border-2 border-line-strong bg-surface p-4">
                    <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-pink">
                      Your rental
                    </div>
                    <div className="flex flex-col gap-2 text-[14px]">
                      <Row label="Drop-off" value={fmtDate(deliveryDate)} />
                      <Row label="Pickup" value={fmtDate(pickupDate!)} />
                      {quote && (
                        <div className="flex justify-between border-t-2 border-line-strong pt-2.5">
                          <span className="text-ink-2">
                            {size.replace("yd", " yd")} · 5 days
                          </span>
                          <span className="cl-nums text-[18px] font-black">
                            {money(quote.subtotal)}
                          </span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setStep(3)}
                      className="mt-3.5 flex w-full items-center justify-between bg-teal px-4 py-3.5 text-[14px] font-extrabold text-white hover:bg-teal-700"
                    >
                      Continue to details <span>→</span>
                    </button>
                  </div>
                )}
                <div className="border-2 border-line bg-surface p-4">
                  <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
                    Reading the calendar
                  </div>
                  <ul className="flex flex-col gap-2.5 text-[13px]">
                    <Legend swatch="border-2 border-line bg-surface" label="Open" />
                    <Legend swatch="bg-teal" label="Your drop-off / pickup" />
                    <Legend swatch="bg-teal-tint" label="On site" />
                    <Legend
                      swatch="bg-orange-tint shadow-[inset_0_0_0_2px_var(--cl-orange)]"
                      label="One or two left"
                    />
                    <Legend swatch="bg-tint" label="Booked out / closed" />
                  </ul>
                </div>
              </div>
            </div>
            <BackButton onClick={() => setStep(1)}>← Change size</BackButton>
          </div>
        )}

        {/* STEP 3 — DETAILS */}
        {step === 3 && size && deliveryDate && (
          <div className="flex flex-col gap-5">
            <div>
              <h1 className="text-[30px] font-black leading-none tracking-[-0.035em]">
                Where is it going?
              </h1>
              <p className="mt-2 text-[15px] text-ink-2">
                The driver needs the address and where on the property to set it.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
              <div className="flex flex-col gap-4">
                <Card title="Delivery address">
                  <Field label="Street address">
                    <input
                      value={street}
                      onChange={(e) => setStreet(e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                  <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
                    <Field label="City">
                      <input
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="State">
                      <input
                        value={stateAbbr}
                        onChange={(e) => setStateAbbr(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="ZIP">
                      <input
                        value={zip}
                        onChange={(e) => setZip(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                </Card>

                <Card title="Where to set it">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {PLACEMENTS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setPlacement(p)}
                        className={`border-2 p-3 text-left text-[13px] font-bold ${
                          placement === p
                            ? "border-teal bg-teal-tint text-teal-tint-ink"
                            : "border-line text-ink hover:border-ink"
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                  <Field label="Anything the driver should know">
                    <textarea
                      value={driverNotes}
                      onChange={(e) => setDriverNotes(e.target.value)}
                      rows={3}
                      className={inputCls}
                    />
                  </Field>
                </Card>

                <Card title="Contact">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name">
                      <input
                        value={contactName}
                        onChange={(e) => setContactName(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Company (optional)">
                      <input
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Mobile — for the driver's text">
                      <input
                        value={contactPhone}
                        onChange={(e) => setContactPhone(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Email — for the receipt">
                      <input
                        value={contactEmail}
                        onChange={(e) => setContactEmail(e.target.value)}
                        className={inputCls}
                      />
                    </Field>
                  </div>
                </Card>

                <Card title="What's going in it">
                  <div className="grid gap-2 sm:grid-cols-3">
                    {DEBRIS.map((d) => (
                      <button
                        key={d}
                        onClick={() => setDebris(debris === d ? "" : d)}
                        className={`border-2 px-3 py-2.5 text-left text-[13px] font-bold ${
                          debris === d
                            ? "border-teal bg-teal-tint text-teal-tint-ink"
                            : "border-line text-ink hover:border-ink"
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </Card>
              </div>

              <div className="flex flex-col gap-4 self-start">
                <SummaryCard
                  size={size}
                  deliveryDate={deliveryDate}
                  pickupDate={pickupDate!}
                  address={`${street || "—"}${city ? `, ${city}` : ""}`}
                  quote={quote}
                >
                  <button
                    disabled={!detailsValid}
                    onClick={() => setStep(4)}
                    className="mt-3.5 flex w-full items-center justify-between bg-teal px-4 py-3.5 text-[14px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    Review &amp; pay <span>→</span>
                  </button>
                </SummaryCard>
                <div className="border-2 border-line bg-surface-2 p-4 text-[13px] text-ink-2">
                  Nothing is charged until the next screen, and nothing is held
                  on the calendar until it is.
                </div>
              </div>
            </div>
            <BackButton onClick={() => setStep(2)}>← Change the date</BackButton>
          </div>
        )}

        {/* STEP 4 — REVIEW & PAY */}
        {step === 4 && size && deliveryDate && (
          <div className="flex flex-col gap-5">
            <div>
              <h1 className="text-[30px] font-black leading-none tracking-[-0.035em]">
                Check it over and pay.
              </h1>
              <p className="mt-2 text-[15px] text-ink-2">
                Sign the rental agreement, pay the flat rate, and the can is on
                the route.
              </p>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
              <div className="flex flex-col gap-4">
                <Card title="Your booking">
                  <dl className="grid gap-4 sm:grid-cols-3">
                    <SummaryItem label="Size" a={size.replace("yd", " yard")} />
                    <SummaryItem
                      label="Drop-off"
                      a={fmtDate(deliveryDate)}
                      b={`Pickup ${fmtDate(pickupDate!)}`}
                    />
                    <SummaryItem
                      label="Address"
                      a={`${street}, ${city}`}
                      b={`${stateAbbr} ${zip}`}
                    />
                    <SummaryItem label="Contact" a={contactName} b={contactPhone || contactEmail} />
                    <SummaryItem label="Placement" a={placement} />
                    <SummaryItem label="Debris" a={debris || "Not specified"} />
                  </dl>
                </Card>

                <div className="border-2 border-line-strong bg-surface">
                  <div className="flex items-center justify-between border-b-2 border-line-strong px-4 py-3">
                    <span className="text-[11px] font-extrabold uppercase tracking-[0.16em]">
                      Rental agreement
                    </span>
                    <span className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-ink-2">
                      {agreementAck ? "Acknowledged" : "Not signed"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 p-4">
                    <p className="flex-1 text-[13px] text-ink-2">
                      Larry&apos;s standard rental agreement, hosted by DocuSign.
                      Open it, complete signing there, then check the box.
                    </p>
                    <button
                      onClick={() => setAgreementOpen(true)}
                      className="border-2 border-ink px-4 py-2.5 text-[13px] font-extrabold hover:bg-tint"
                    >
                      Read &amp; sign
                    </button>
                  </div>
                </div>

                <div className="border-2 border-line-strong bg-surface">
                  <div className="flex items-center justify-between border-b-2 border-line-strong px-4 py-3">
                    <span className="text-[11px] font-extrabold uppercase tracking-[0.16em]">
                      Payment
                    </span>
                    <span className="bg-[#2ca01c] px-2 py-1 text-[10px] font-extrabold uppercase tracking-[0.1em] text-white">
                      QuickBooks Payments
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 p-4">
                    <p className="border-2 border-dashed border-line bg-surface-2 px-3 py-3 text-[13px] text-ink-2">
                      <strong className="text-ink">
                        Payment isn&apos;t wired up yet (Phase 5).
                      </strong>{" "}
                      QuickBooks Payments card + ACH entry goes here. For now,
                      &quot;Pay &amp; book it&quot; creates the booking without
                      charging anything.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-4 self-start">
                <div className="border-2 border-line-strong bg-surface p-4">
                  <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-pink">
                    Total
                  </div>
                  {quote ? (
                    <div className="flex flex-col gap-2 text-[14px]">
                      <div className="flex justify-between">
                        <span className="text-ink-2">
                          {size.replace("yd", " yd")} · 5 days · 1 ton
                        </span>
                        <span className="cl-nums font-bold">
                          {money(quote.subtotal)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-2">Delivery &amp; haul</span>
                        <span className="font-bold">Included</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-2">
                          Sales tax
                          {pricing.settings.tax_jurisdiction
                            ? ` (${pricing.settings.tax_jurisdiction})`
                            : ""}
                        </span>
                        <span className="cl-nums font-bold">
                          {money(quote.tax)}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between border-t-2 border-line-strong pt-3">
                        <span className="text-[15px] font-extrabold">
                          Due now
                        </span>
                        <span className="cl-nums text-[28px] font-black tracking-[-0.03em]">
                          {money(quote.total)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[13px] text-ink-2">
                      Pricing unavailable — call the yard.
                    </p>
                  )}
                  <button
                    disabled={pending || !agreementAck || !quote}
                    onClick={submit}
                    className="mt-4 flex w-full items-center justify-between bg-teal px-4 py-4 text-[15px] font-extrabold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {pending ? "Booking…" : "Pay & book it"} <span>→</span>
                  </button>
                  {!agreementAck && (
                    <p className="mt-2 text-[12px] text-ink-3">
                      Complete the rental agreement to continue.
                    </p>
                  )}
                  {error && (
                    <p className="mt-2 border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
                      {error}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <BackButton onClick={() => setStep(3)}>← Back to details</BackButton>
          </div>
        )}
      </div>

      <AgreementModal
        open={agreementOpen}
        onClose={() => setAgreementOpen(false)}
        onAcknowledge={setAgreementAck}
        acknowledged={agreementAck}
        size={size ?? ""}
        docusignUrl={docusignUrl}
      />
    </div>
  );
}

const inputCls =
  "w-full border-2 border-line bg-bg px-3 py-2.5 text-[15px] text-ink";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-ink-2">
        {label}
      </span>
      {children}
    </label>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-2 border-line-strong bg-surface">
      <div className="border-b-2 border-line-strong px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.16em]">
        {title}
      </div>
      <div className="flex flex-col gap-3.5 p-4">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-ink-2">{label}</span>
      <span className="font-extrabold">{value}</span>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className={`h-3.5 w-3.5 flex-none ${swatch}`} />
      {label}
    </li>
  );
}

function BackButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="self-start border-2 border-ink px-4 py-2.5 text-[13px] font-extrabold hover:bg-tint"
    >
      {children}
    </button>
  );
}

function SummaryCard({
  size,
  deliveryDate,
  pickupDate,
  address,
  quote,
  children,
}: {
  size: string;
  deliveryDate: string;
  pickupDate: string;
  address: string;
  quote: { subtotal: number; tax: number; total: number } | null;
  children: React.ReactNode;
}) {
  return (
    <div className="border-2 border-line-strong bg-surface p-4">
      <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-pink">
        Your booking so far
      </div>
      <div className="flex flex-col gap-2 text-[14px]">
        <Row label="Size" value={size.replace("yd", " yard")} />
        <Row label="Drop-off" value={fmtDate(deliveryDate)} />
        <Row label="Pickup" value={fmtDate(pickupDate)} />
        <Row label="Address" value={address} />
        {quote && (
          <div className="flex justify-between border-t-2 border-line-strong pt-2.5">
            <span className="text-ink-2">Subtotal</span>
            <span className="cl-nums text-[18px] font-black">
              {money(quote.subtotal)}
            </span>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function SummaryItem({
  label,
  a,
  b,
}: {
  label: string;
  a: string;
  b?: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-ink-3">
        {label}
      </div>
      <div className="text-[15px] font-extrabold">{a}</div>
      {b && <div className="text-[13px] text-ink-2">{b}</div>}
    </div>
  );
}
