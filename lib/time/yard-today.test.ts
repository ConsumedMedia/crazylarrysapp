/**
 * Unit test — the yard's calendar day, with the clock faked. Every case runs
 * twice: with the process in UTC (Vercel) and in Asia/Tokyo (ahead of UTC),
 * so nothing can lean on the machine's own zone. Node applies a runtime
 * change to process.env.TZ, including on Windows; the first test in each
 * block proves the switch took effect.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { yardDateOf, yardMidnight, yardToday, yardTomorrow } from "./yard";

// [label, instant, yard today, yard tomorrow]
const CLOCK: Array<[string, string, string, string]> = [
  ["3:45 PM EDT Thu Oct 29", "2026-10-29T19:45:00Z", "2026-10-29", "2026-10-30"],
  ["9:00 PM EDT Thu Oct 29 (UTC is already Oct 30)", "2026-10-30T01:00:00Z", "2026-10-29", "2026-10-30"],
  ["11:59 PM EDT Thu Oct 29", "2026-10-30T03:59:00Z", "2026-10-29", "2026-10-30"],
  ["midnight EDT Fri Oct 30", "2026-10-30T04:00:00Z", "2026-10-30", "2026-10-31"],
  ["9:00 PM EDT Sat Oct 31", "2026-11-01T01:00:00Z", "2026-10-31", "2026-11-01"],
  ["1:30 AM EDT Sun Nov 1 (first time)", "2026-11-01T05:30:00Z", "2026-11-01", "2026-11-02"],
  ["1:30 AM EST Sun Nov 1 (repeated hour)", "2026-11-01T06:30:00Z", "2026-11-01", "2026-11-02"],
  ["9:00 PM EST Sun Nov 1 (after DST ends)", "2026-11-02T02:00:00Z", "2026-11-01", "2026-11-02"],
  ["11:30 PM EST Sun Nov 1 (a fixed -4h would say Nov 2)", "2026-11-02T04:30:00Z", "2026-11-01", "2026-11-02"],
  ["midnight EST Mon Nov 2", "2026-11-02T05:00:00Z", "2026-11-02", "2026-11-03"],
  ["9:00 PM EST Thu Dec 31 (year end)", "2027-01-01T02:00:00Z", "2026-12-31", "2027-01-01"],
  ["11:59 PM EST Sat Mar 13 2027 (before spring forward)", "2027-03-14T04:59:00Z", "2027-03-13", "2027-03-14"],
  ["midnight EST Sun Mar 14 2027", "2027-03-14T05:00:00Z", "2027-03-14", "2027-03-15"],
];

describe.each(["UTC", "Asia/Tokyo"])("yard day with the process in %s", (zone) => {
  let savedTz: string | undefined;
  beforeAll(() => {
    savedTz = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs with the process actually in that zone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
  });

  it.each(CLOCK)("%s: today and tomorrow from an explicit clock", (_label, at, today, tomorrow) => {
    expect(yardToday(new Date(at))).toBe(today);
    expect(yardTomorrow(new Date(at))).toBe(tomorrow);
  });

  it.each(CLOCK)("%s: today and tomorrow from the faked system clock", (_label, at, today, tomorrow) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    expect(yardToday()).toBe(today);
    expect(yardTomorrow()).toBe(tomorrow);
  });

  it("dates a stored paid_at by the yard's day, in each format the database returns", () => {
    expect(yardDateOf("2026-10-30T01:30:00+00:00")).toBe("2026-10-29");
    expect(yardDateOf("2026-10-30 01:30:00+00")).toBe("2026-10-29");
    expect(yardDateOf("2026-10-30T01:30:00.123456+00:00")).toBe("2026-10-29");
    expect(yardDateOf("2027-01-01T02:00:00Z")).toBe("2026-12-31"); // stays in last year's books
    expect(yardDateOf("2026-10-29T14:00:00Z")).toBe("2026-10-29");
  });

  it("refuses something that isn't a timestamp", () => {
    expect(() => yardDateOf("not a date")).toThrow(RangeError);
  });

  it("finds the instant the yard's day starts, across both DST changes", () => {
    expect(yardMidnight("2026-10-29").toISOString()).toBe("2026-10-29T04:00:00.000Z"); // EDT
    expect(yardMidnight("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z"); // still EDT at midnight
    expect(yardMidnight("2026-11-02").toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST
    expect(yardMidnight("2027-03-14").toISOString()).toBe("2027-03-14T05:00:00.000Z"); // EST at midnight
    expect(yardMidnight("2027-03-15").toISOString()).toBe("2027-03-15T04:00:00.000Z"); // EDT
    // The day of the DST change is 25 hours long; every other day is 24.
    const hours = (a: string, b: string) => (yardMidnight(b).getTime() - yardMidnight(a).getTime()) / 3_600_000;
    expect(hours("2026-11-01", "2026-11-02")).toBe(25);
    expect(hours("2027-03-14", "2027-03-15")).toBe(23);
    expect(hours("2026-10-29", "2026-10-30")).toBe(24);
  });
});
