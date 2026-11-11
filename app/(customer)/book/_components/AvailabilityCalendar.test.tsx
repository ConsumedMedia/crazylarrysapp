/**
 * The customer calendar and the order cutoff, run through the real component
 * with test/mini-render (real state and effects, no DOM). fetch is a fake that
 * answers /api/availability; the clock and timers are fake.
 *
 * The clock: Wed Nov 11, 2026. Tomorrow is Nov 12; with the cutoff passed the
 * online floor is Nov 13.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { mount } from "@/test/mini-render";
import type { DeliveryFloor } from "@/lib/bookings/cutoff-shared";

vi.mock("react", async (orig) => {
  const { hooks } = await import("@/test/mini-render");
  return { ...(await orig<object>()), ...hooks };
});

import { AvailabilityCalendar } from "./AvailabilityCalendar";

const BEFORE: DeliveryFloor = {
  earliestOnline: "2026-11-12",
  earliestStaff: "2026-11-12",
  cutoffEnabled: true,
  cutoffTime: "15:00",
  afterCutoff: false,
  nextChangeAt: "2026-11-11T20:00:00.000Z",
  source: "database",
};
const AFTER: DeliveryFloor = { ...BEFORE, earliestOnline: "2026-11-13", afterCutoff: true, nextChangeAt: "2026-11-12T05:00:00.000Z" };
const FALLBACK: DeliveryFloor = { ...BEFORE, cutoffEnabled: false, nextChangeAt: "2026-11-12T05:00:00.000Z", source: "fallback" };

const openDay = (date: string) => ({ date, total: 6, committed: 0, available: 6, state: "open" });
let floors: DeliveryFloor[];
const fetchCalls: string[] = [];

function respond() {
  const floor = floors[Math.min(fetchCalls.length - 1, floors.length - 1)];
  return {
    ok: true,
    json: async () => ({ size: "15yd", rentalDays: 5, days: ["2026-11-12", "2026-11-13", "2026-11-14"].map(openDay), floor }),
  };
}

/** Let the fake fetch and its .then chain settle (setImmediate isn't faked). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
/** Buttons are the selectable days; their text starts with the day of the month. */
const selectableDays = (m: ReturnType<typeof mount>) =>
  m.hosts().filter((h) => h.type === "button" && /^\d+/.test(h.text)).map((h) => Number(/^\d+/.exec(h.text)![0]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-11T19:59:58.000Z")); // 2:59:58 PM Eastern
  fetchCalls.length = 0;
  floors = [AFTER];
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls.push(url);
    return respond();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(props: Record<string, unknown>) {
  const m = mount(() => createElement(AvailabilityCalendar, { size: "15yd", ...props }));
  m.hosts(); // mount() renders lazily: this first render runs the fetch effect
  await flush();
  m.hosts();
  return m;
}

describe("AvailabilityCalendar and the order cutoff", () => {
  it("applyCutoff: tomorrow closed by the cutoff isn't selectable; the note says why", async () => {
    const m = await render({ applyCutoff: true, onSelectDate: () => {} });
    expect(selectableDays(m)).toEqual([13, 14]);
    expect(m.text()).toContain("Orders placed after 3:00 PM Eastern are delivered from the day after tomorrow.");
  });

  it("without applyCutoff (the staff phone calendar): tomorrow stays selectable and no note shows", async () => {
    const m = await render({ onSelectDate: () => {} });
    expect(selectableDays(m)).toEqual([12, 13, 14]);
    expect(m.text()).not.toContain("Orders placed after");
  });

  it("fallback floor (database answer unavailable): today's rule, tomorrow selectable, no note", async () => {
    floors = [FALLBACK];
    const m = await render({ applyCutoff: true, onSelectDate: () => {} });
    expect(selectableDays(m)).toEqual([12, 13, 14]);
    expect(m.text()).not.toContain("Orders placed after");
  });

  it("the cutoff passes while the customer sits on the page: it refetches, closes tomorrow and clears the pick with the reason", async () => {
    floors = [BEFORE, AFTER];
    let selected: string | null = "2026-11-12";
    const onDateClosed = vi.fn(() => {
      selected = null;
    });
    const m = mount(() =>
      createElement(AvailabilityCalendar, {
        size: "15yd",
        selectedDate: selected,
        onSelectDate: (d: string) => void (selected = d),
        applyCutoff: true,
        onDateClosed,
      }),
    );
    m.hosts();
    await flush();
    m.hosts();
    expect(fetchCalls).toHaveLength(1);
    expect(onDateClosed).not.toHaveBeenCalled();

    // 2:59:58 PM -> the timer is due 1.5 s after 3:00 PM (3.5 s from now): not yet at 3.4 s.
    vi.advanceTimersByTime(3_400);
    m.hosts();
    expect(fetchCalls).toHaveLength(1);
    vi.advanceTimersByTime(200);
    m.hosts();
    await flush();
    m.hosts();
    expect(fetchCalls).toHaveLength(2);
    expect(onDateClosed).toHaveBeenCalledTimes(1);
    expect(selected).toBeNull();
    expect(selectableDays(m)).toEqual([13, 14]);
    expect(m.text()).toContain(
      "It's past 3:00 PM Eastern, so tomorrow is no longer available. The earliest delivery is Friday, Nov 13. You have not been charged.",
    );
  });

  it("no timer refetch before the floor changes, and none at all without applyCutoff", async () => {
    floors = [BEFORE];
    await render({ applyCutoff: true, onSelectDate: () => {} });
    vi.advanceTimersByTime(1_000);
    expect(fetchCalls).toHaveLength(1);

    fetchCalls.length = 0;
    await render({ onSelectDate: () => {} });
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(fetchCalls).toHaveLength(1);
  });

  it("a pick on a day that is still open is never cleared", async () => {
    floors = [AFTER];
    const onDateClosed = vi.fn();
    await render({ applyCutoff: true, selectedDate: "2026-11-13", onSelectDate: () => {}, onDateClosed });
    expect(onDateClosed).not.toHaveBeenCalled();
  });
});
