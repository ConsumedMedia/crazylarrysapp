"use client";

import { useEffect, useMemo, useState } from "react";
import { DAY_NAMES, MONTH_NAMES, monthGrid, parseYmd } from "@/lib/availability/dates";
import type { AvailabilityDay, RangeAvailability } from "@/lib/availability/types";
import type { DumpsterSize } from "@/lib/dumpsters/state-machine";

type DayMap = Record<string, AvailabilityDay>;

export interface ChangeDateCalendarProps {
  size: DumpsterSize;
  /** The date this field is currently scheduled for — marked distinctly. */
  currentDate: string;
  /** Selected new date, or null if none chosen yet. */
  value: string | null;
  onSelect: (date: string) => void;
}

/**
 * Day-by-day availability for one date field on a change request. Uses the
 * same /api/availability + size_availability RPC as the booking calendar,
 * but with rentalDays=1 — that turns the RPC's "room for a new N-day rental
 * starting here" check into plain single-day occupancy, which is the right
 * question for "is this size free on this one day" rather than "could a
 * fresh booking start here."
 *
 * Unlike the booking calendar, every non-past day stays clickable — a
 * change request goes to staff either way, so a tight day is a warning, not
 * a hard stop.
 */
export function ChangeDateCalendar({
  size,
  currentDate,
  value,
  onSelect,
}: ChangeDateCalendarProps) {
  const [anchor, setAnchor] = useState<Date>(() => parseYmd(currentDate));
  const [data, setData] = useState<DayMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const grid = useMemo(() => monthGrid(anchor), [anchor]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/availability?size=${size}&from=${grid.from}&to=${grid.to}&rentalDays=1`;
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
  }, [size, grid.from, grid.to]);

  const selectedDay = value ? data[value] : undefined;
  const showTightWarning =
    value &&
    value !== currentDate &&
    selectedDay &&
    (selectedDay.state === "bookedout" || selectedDay.state === "closed" || selectedDay.state === "limited");

  return (
    <div className="flex flex-col gap-2">
      <div className="border-2 border-line-strong bg-surface">
        <div className="flex items-center justify-between gap-2.5 border-b-2 border-line-strong px-3 py-2">
          <div className="text-[13px] font-extrabold">
            {MONTH_NAMES[grid.month]} {grid.year}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() =>
                setAnchor((a) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() - 1, 1)))
              }
              aria-label="Previous month"
              className="h-[28px] w-[28px] border-2 border-line text-[13px] font-extrabold hover:border-ink"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() =>
                setAnchor((a) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 1)))
              }
              aria-label="Next month"
              className="h-[28px] w-[28px] border-2 border-line text-[13px] font-extrabold hover:border-ink"
            >
              ›
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-px bg-line p-px">
          {DAY_NAMES.map((d) => (
            <div
              key={d}
              className="bg-surface py-1 text-center text-[9px] font-extrabold uppercase tracking-[0.1em] text-ink-3"
            >
              {d}
            </div>
          ))}
          {grid.cells.map((cell) => {
            const day = data[cell.date];
            const isCurrent = cell.date === currentDate;
            const isSelected = cell.date === value;
            const past = !!day && day.state === "past";
            return (
              <DayCell
                key={cell.date}
                dayOfMonth={cell.dayOfMonth}
                inMonth={cell.inMonth}
                day={day}
                loading={loading}
                isCurrent={isCurrent}
                isSelected={isSelected}
                onSelect={!past ? () => onSelect(cell.date) : undefined}
              />
            );
          })}
        </div>
      </div>

      {error && (
        <p className="text-[11px] font-semibold text-orange-tint-ink">
          Couldn&apos;t load availability: {error}
        </p>
      )}
      {showTightWarning && (
        <p className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink">
          {selectedDay!.state === "limited"
            ? `Only ${selectedDay!.available} unit${selectedDay!.available === 1 ? "" : "s"} of this size free that day.`
            : "This size looks fully booked that day."}{" "}
          You can still send the request — the office will let you know if it works.
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
  isCurrent,
  isSelected,
  onSelect,
}: {
  dayOfMonth: number;
  inMonth: boolean;
  day: AvailabilityDay | undefined;
  loading: boolean;
  isCurrent: boolean;
  isSelected: boolean;
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
  } else if (isSelected) {
    bg = "bg-teal";
    ink = "text-white";
    note = "Requested";
    noteInk = "text-white/90";
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
    note = "Full";
  } else if (day.state === "limited") {
    bg = "bg-orange-tint";
    ink = "text-orange-tint-ink";
    note = `${day.available} left`;
    noteInk = "text-orange-tint-ink";
  } else {
    note = "Open";
  }

  if (isCurrent && !isSelected) {
    ring = "shadow-[inset_0_0_0_2px_var(--cl-ink)]";
    note = note || "Current";
  }

  const Tag = onSelect ? "button" : "div";
  return (
    <Tag
      type={onSelect ? "button" : undefined}
      onClick={onSelect}
      className={`flex min-h-[56px] flex-col gap-0.5 p-1.5 text-left ${bg} ${ring} ${
        onSelect ? "cursor-pointer hover:shadow-[inset_0_0_0_2px_var(--cl-ink)]" : ""
      }`}
    >
      <span className={`cl-nums text-[12px] font-extrabold ${ink}`}>{dayOfMonth}</span>
      {note && (
        <span
          className={`text-[8px] font-extrabold uppercase leading-tight tracking-[0.06em] ${noteInk}`}
        >
          {note}
        </span>
      )}
    </Tag>
  );
}
