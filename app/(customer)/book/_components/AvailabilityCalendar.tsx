"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DAY_NAMES,
  MONTH_NAMES,
  monthGrid,
  rentalWindow,
} from "@/lib/availability/dates";
import { DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import { DUMPSTER_SIZES, type DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { AvailabilityDay, RangeAvailability } from "@/lib/availability/types";

const SIZE_BLURB: Record<DumpsterSize, string> = {
  "10yd": "Bathroom or single-room cleanout, roofing tear-off up to ~25 sq.",
  "15yd": "Whole-room renovation, flooring, decking, garage cleanout.",
  "20yd": "Whole-house cleanout, large additions, commercial jobs.",
};

type DayMap = Record<string, AvailabilityDay>;

export function AvailabilityCalendar({
  initialSize = "15yd",
  rentalDays = DEFAULT_RENTAL_DAYS,
}: {
  initialSize?: DumpsterSize;
  rentalDays?: number;
}) {
  const [size, setSize] = useState<DumpsterSize>(initialSize);
  const [anchor, setAnchor] = useState<Date>(() => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<DayMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const grid = useMemo(() => monthGrid(anchor), [anchor]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/availability?size=${size}&from=${grid.from}&to=${grid.to}&rentalDays=${rentalDays}`;
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        return (await r.json()) as RangeAvailability;
      })
      .then((res) => {
        if (cancelled) return;
        const map: DayMap = {};
        for (const d of res.days) map[d.date] = d;
        setData(map);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [size, grid.from, grid.to, rentalDays]);

  const windowDays = useMemo(
    () => (selected ? new Set(rentalWindow(selected, rentalDays)) : new Set<string>()),
    [selected, rentalDays],
  );
  const pickupDay = selected ? rentalWindow(selected, rentalDays).at(-1)! : null;

  function shiftMonth(delta: number) {
    setSelected(null);
    setAnchor(
      (a) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + delta, 1)),
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Size selector */}
      <div className="flex flex-wrap gap-2">
        {DUMPSTER_SIZES.map((s) => (
          <button
            key={s}
            onClick={() => {
              setSize(s);
              setSelected(null);
            }}
            className={`border-2 px-4 py-2 text-left text-[13px] font-extrabold ${
              size === s
                ? "border-teal bg-teal-tint text-teal-tint-ink"
                : "border-line text-ink hover:border-ink"
            }`}
          >
            {s.replace("yd", " yd")}
          </button>
        ))}
      </div>
      <p className="text-[13px] text-ink-2">{SIZE_BLURB[size]}</p>

      <div className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        {/* Calendar card */}
        <div className="self-start border-2 border-line-strong bg-surface">
          <div className="flex items-center justify-between gap-2.5 border-b-2 border-line-strong px-4 py-3">
            <div className="text-[17px] font-extrabold">
              {MONTH_NAMES[grid.month]} {grid.year}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => shiftMonth(-1)}
                aria-label="Previous month"
                className="h-[34px] w-[34px] border-2 border-line text-[15px] font-extrabold hover:border-ink"
              >
                ‹
              </button>
              <button
                onClick={() => shiftMonth(1)}
                aria-label="Next month"
                className="h-[34px] w-[34px] border-2 border-line text-[15px] font-extrabold hover:border-ink"
              >
                ›
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-px bg-line p-px">
            {DAY_NAMES.map((d) => (
              <div
                key={d}
                className="bg-surface py-1.5 text-center text-[10px] font-extrabold uppercase tracking-[0.1em] text-ink-3"
              >
                {d}
              </div>
            ))}

            {grid.cells.map((cell) => {
              const day = data[cell.date];
              const inWindow = windowDays.has(cell.date);
              const isDrop = cell.date === selected;
              const isPickup = cell.date === pickupDay;
              return (
                <DayCell
                  key={cell.date}
                  dayOfMonth={cell.dayOfMonth}
                  inMonth={cell.inMonth}
                  day={day}
                  loading={loading}
                  isDrop={isDrop}
                  isPickup={isPickup}
                  inWindow={inWindow && !isDrop && !isPickup}
                  onSelect={
                    day && (day.state === "open" || day.state === "limited")
                      ? () => setSelected(cell.date)
                      : undefined
                  }
                />
              );
            })}
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          {selected && (
            <div className="border-2 border-line-strong bg-surface p-4">
              <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-pink">
                Your rental
              </div>
              <div className="flex flex-col gap-2 text-[14px]">
                <Row label="Drop-off" value={fmt(selected)} />
                <Row label="Pickup" value={fmt(pickupDay!)} />
                <div className="flex justify-between border-t-2 border-line-strong pt-2.5 text-ink-2">
                  <span>
                    {size.replace("yd", " yd")} · {rentalDays} days
                  </span>
                  <span className="font-extrabold text-ink">
                    {data[selected]?.available} left
                  </span>
                </div>
              </div>
              <p className="mt-3 border-2 border-line bg-bg px-3 py-2 text-[12px] text-ink-2">
                Booking opens in the next step (Phase 4). This calendar is
                read-only for now.
              </p>
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
                swatch="bg-orange-tint shadow-[inset_0_0_0_2px_var(--cl-orange-tint-ink)]"
                label="One or two left"
              />
              <Legend swatch="bg-tint" label="Booked out / closed" />
            </ul>
          </div>

          {error && (
            <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
              Couldn&apos;t load availability: {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DayCell({
  dayOfMonth,
  inMonth,
  day,
  loading,
  isDrop,
  isPickup,
  inWindow,
  onSelect,
}: {
  dayOfMonth: number;
  inMonth: boolean;
  day: AvailabilityDay | undefined;
  loading: boolean;
  isDrop: boolean;
  isPickup: boolean;
  inWindow: boolean;
  onSelect?: () => void;
}) {
  let bg = "bg-surface";
  let ink = "text-ink";
  let note = "";
  let noteInk = "text-ink-3";
  let ring = "";

  if (!inMonth) {
    bg = "bg-bg";
    ink = "text-ink-3";
  } else if (isDrop || isPickup) {
    bg = "bg-teal";
    ink = "text-white";
    note = isDrop ? "Drop-off" : "Pickup";
    noteInk = "text-white/90";
  } else if (inWindow) {
    bg = "bg-teal-tint";
    ink = "text-teal-tint-ink";
    note = "On site";
    noteInk = "text-teal-tint-ink";
  } else if (loading || !day) {
    note = loading ? "…" : "";
  } else if (day.state === "past") {
    bg = "bg-bg";
    ink = "text-ink-3";
  } else if (day.state === "closed") {
    bg = "bg-tint";
    ink = "text-ink-3";
    note = "Closed";
  } else if (day.state === "bookedout") {
    bg = "bg-tint";
    ink = "text-ink-3";
    note = "Booked out";
  } else if (day.state === "limited") {
    bg = "bg-orange-tint";
    ink = "text-orange-tint-ink";
    note = `${day.available} left`;
    noteInk = "text-orange-tint-ink";
    ring = "shadow-[inset_0_0_0_2px_var(--cl-orange)]";
  } else {
    note = "Open";
  }

  const Tag = onSelect ? "button" : "div";
  return (
    <Tag
      onClick={onSelect}
      className={`flex min-h-[74px] flex-col gap-0.5 p-1.5 text-left ${bg} ${ring} ${
        onSelect ? "cursor-pointer hover:shadow-[inset_0_0_0_2px_var(--cl-ink)]" : ""
      }`}
    >
      <span className={`cl-nums text-[14px] font-extrabold ${ink}`}>
        {dayOfMonth}
      </span>
      {note && (
        <span
          className={`text-[9px] font-extrabold uppercase leading-tight tracking-[0.06em] ${noteInk}`}
        >
          {note}
        </span>
      )}
    </Tag>
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

function fmt(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
