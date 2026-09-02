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

type DayMap = Record<string, AvailabilityDay>;

export interface AvailabilityCalendarProps {
  rentalDays?: number;
  /** Controlled size. Omit for the standalone size selector. */
  size?: DumpsterSize;
  onSizeChange?: (s: DumpsterSize) => void;
  /** Controlled selected delivery date (yyyy-mm-dd). */
  selectedDate?: string | null;
  onSelectDate?: (date: string) => void;
}

export function AvailabilityCalendar({
  rentalDays = DEFAULT_RENTAL_DAYS,
  size: controlledSize,
  onSizeChange,
  selectedDate: controlledSelected,
  onSelectDate,
}: AvailabilityCalendarProps) {
  const [internalSize, setInternalSize] = useState<DumpsterSize>("15yd");
  const size = controlledSize ?? internalSize;
  const setSize = (s: DumpsterSize) => {
    if (onSizeChange) onSizeChange(s);
    else setInternalSize(s);
  };

  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const selected = controlledSelected ?? internalSelected;
  const selectDate = (d: string) => {
    if (onSelectDate) onSelectDate(d);
    else setInternalSelected(d);
  };

  const [anchor, setAnchor] = useState<Date>(() => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  });
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
    () =>
      selected
        ? new Set(rentalWindow(selected, rentalDays))
        : new Set<string>(),
    [selected, rentalDays],
  );
  const pickupDay = selected
    ? rentalWindow(selected, rentalDays).at(-1)!
    : null;

  return (
    <div className="flex flex-col gap-4">
      {!controlledSize && (
        <div className="flex flex-wrap gap-2">
          {DUMPSTER_SIZES.map((s) => (
            <button
              key={s}
              onClick={() => setSize(s)}
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
      )}

      <div className="self-start border-2 border-line-strong bg-surface">
        <div className="flex items-center justify-between gap-2.5 border-b-2 border-line-strong px-4 py-3">
          <div className="text-[17px] font-extrabold">
            {MONTH_NAMES[grid.month]} {grid.year}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() =>
                setAnchor(
                  (a) =>
                    new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() - 1, 1)),
                )
              }
              aria-label="Previous month"
              className="h-[34px] w-[34px] border-2 border-line text-[15px] font-extrabold hover:border-ink"
            >
              ‹
            </button>
            <button
              onClick={() =>
                setAnchor(
                  (a) =>
                    new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 1)),
                )
              }
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
            const isDrop = cell.date === selected;
            const isPickup = cell.date === pickupDay;
            const inWindow =
              windowDays.has(cell.date) && !isDrop && !isPickup;
            const selectable =
              !!day && (day.state === "open" || day.state === "limited");
            return (
              <DayCell
                key={cell.date}
                dayOfMonth={cell.dayOfMonth}
                inMonth={cell.inMonth}
                day={day}
                loading={loading}
                isDrop={isDrop}
                isPickup={isPickup}
                inWindow={inWindow}
                onSelect={selectable ? () => selectDate(cell.date) : undefined}
              />
            );
          })}
        </div>
      </div>

      {error && (
        <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
          Couldn&apos;t load availability: {error}
        </p>
      )}
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
        onSelect
          ? "cursor-pointer hover:shadow-[inset_0_0_0_2px_var(--cl-ink)]"
          : ""
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
