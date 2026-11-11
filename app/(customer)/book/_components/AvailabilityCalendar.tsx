"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DAY_NAMES,
  MONTH_NAMES,
  monthGrid,
  parseYmd,
  rentalWindow,
} from "@/lib/availability/dates";
import { yardTomorrow } from "@/lib/time/yard";
import { applyOnlineFloor, DEFAULT_RENTAL_DAYS } from "@/lib/availability/compute";
import { DUMPSTER_SIZES, type DumpsterSize } from "@/lib/dumpsters/state-machine";
import type { AvailabilityDay, RangeAvailability } from "@/lib/availability/types";
import {
  cutoffClosedMessage,
  cutoffNote,
  isClosedByCutoff,
  type DeliveryFloor,
} from "@/lib/bookings/cutoff-shared";
import { Skeleton } from "@/lib/design/Skeleton";

type DayMap = Record<string, AvailabilityDay>;

/** Never wait longer than this for the next refresh (the floor moves at least daily). */
const MAX_REFRESH_DELAY_MS = 24 * 60 * 60 * 1000;
/** Refresh just after the floor changes, not on the edge. */
const REFRESH_SLACK_MS = 1500;

export interface AvailabilityCalendarProps {
  rentalDays?: number;
  /** Controlled size. Omit for the standalone size selector. */
  size?: DumpsterSize;
  onSizeChange?: (s: DumpsterSize) => void;
  /** Controlled selected delivery date (yyyy-mm-dd). */
  selectedDate?: string | null;
  onSelectDate?: (date: string) => void;
  /**
   * Apply the online order cutoff (the /book calendar). Off by default, so the
   * staff calendar keeps today's rule. When on, the calendar refreshes the
   * moment the floor changes and clears a picked day the cutoff just closed.
   */
  applyCutoff?: boolean;
  /** Called when the picked day was closed by the cutoff (controlled use: clear it). */
  onDateClosed?: () => void;
}

export function AvailabilityCalendar({
  rentalDays = DEFAULT_RENTAL_DAYS,
  size: controlledSize,
  onSizeChange,
  selectedDate: controlledSelected,
  onSelectDate,
  applyCutoff = false,
  onDateClosed,
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
    setClosedNotice(null);
    if (onSelectDate) onSelectDate(d);
    else setInternalSelected(d);
  };

  // Open on the month holding the earliest delivery day (the yard's tomorrow).
  const [anchor, setAnchor] = useState<Date>(() => {
    const t = parseYmd(yardTomorrow());
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  });
  const [data, setData] = useState<DayMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [floor, setFloor] = useState<DeliveryFloor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [closedNotice, setClosedNotice] = useState<string | null>(null);

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
        const f = applyCutoff ? res.floor ?? null : null;
        const map: DayMap = {};
        for (const d of res.days) map[d.date] = f ? applyOnlineFloor(d, f) : d;
        setFloor(f);
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
  }, [size, grid.from, grid.to, rentalDays, applyCutoff, refreshKey]);

  // Refetch the moment the floor changes (the cutoff, or the yard's midnight).
  useEffect(() => {
    if (!applyCutoff || !floor) return;
    const due = Date.parse(floor.nextChangeAt) - Date.now() + REFRESH_SLACK_MS;
    const delay = Math.min(Math.max(due, REFRESH_SLACK_MS), MAX_REFRESH_DELAY_MS);
    const t = setTimeout(() => setRefreshKey((k) => k + 1), delay);
    return () => clearTimeout(t);
  }, [applyCutoff, floor]);

  // A picked day the cutoff has closed is cleared, with the reason.
  useEffect(() => {
    if (!applyCutoff || !floor || !selected || !isClosedByCutoff(selected, floor)) return;
    setClosedNotice(cutoffClosedMessage(floor));
    if (onDateClosed) onDateClosed();
    else setInternalSelected(null);
  }, [applyCutoff, floor, selected, onDateClosed]);

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
              type="button"
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

      <div className="w-full border-2 border-line-strong bg-surface">
        <div className="flex items-center justify-between gap-2.5 border-b-2 border-line-strong px-4 py-3">
          <div className="text-[17px] font-extrabold">
            {MONTH_NAMES[grid.month]} {grid.year}
          </div>
          <div className="flex gap-1">
            <button
              type="button"
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
              type="button"
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

        <div
          key={`${grid.from}-${loading}`}
          className="cl-fade-in grid grid-cols-7 gap-px bg-line p-px"
        >
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

      {applyCutoff && floor && cutoffNote(floor) && (
        <p className="text-[11px] text-ink-3" data-testid="cutoff-note">
          {cutoffNote(floor)}
        </p>
      )}

      {applyCutoff && closedNotice && (
        <p
          role="status"
          data-testid="cutoff-closed"
          className="border-l-4 border-orange bg-orange-tint px-3 py-2 text-[12px] font-semibold text-orange-tint-ink"
        >
          {closedNotice}
        </p>
      )}

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
  const showSkeleton = inMonth && !isDrop && !isPickup && !inWindow && (loading || !day);

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
    // handled by showSkeleton below
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
      // Never a submit button: the calendar also lives inside the staff
      // /bookings/new <form>, where a default-type button would submit it.
      type={onSelect ? "button" : undefined}
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
      {showSkeleton && <Skeleton className="h-[9px] w-8" />}
      {!showSkeleton && note && (
        <span
          className={`text-[9px] font-extrabold uppercase leading-tight tracking-[0.06em] ${noteInk}`}
        >
          {note}
        </span>
      )}
    </Tag>
  );
}
