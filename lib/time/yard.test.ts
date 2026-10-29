/**
 * Unit test — forces the process into UTC (Vercel's clock) so a formatter
 * that leans on the server's zone fails here even on an Eastern-time machine.
 * Node applies a runtime change to process.env.TZ, including on Windows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { formatYardDate, formatYardDateTime, formatYardTime } from "./yard";

// Some ICU versions put a narrow no-break space before AM/PM.
const plain = (s: string) => s.replace(/ /g, " ");

let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("yard time formatting on a UTC server", () => {
  it("runs with the process actually in UTC", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
  });

  it("shows Eastern daylight time", () => {
    expect(plain(formatYardDateTime("2026-10-29T14:05:00Z"))).toBe("Oct 29, 10:05 AM");
  });

  it("keeps a late-evening timestamp on its Ohio day, not the next UTC day", () => {
    expect(plain(formatYardDateTime("2026-10-30T02:30:00Z"))).toBe("Oct 29, 10:30 PM");
    expect(formatYardDate("2026-10-30T02:30:00Z")).toBe("10/29/2026");
  });

  it("switches to standard time when daylight saving ends (Nov 1, 2026)", () => {
    expect(plain(formatYardDateTime("2026-11-02T14:05:00Z"))).toBe("Nov 2, 9:05 AM");
  });

  it("overrides any timeZone a caller passes", () => {
    expect(plain(formatYardTime("2026-10-29T14:05:00Z", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }))).toBe(
      "10:05 AM",
    );
  });
});
