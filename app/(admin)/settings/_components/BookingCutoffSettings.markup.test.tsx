/**
 * Snapshot of the Settings → Order cutoff panel in each state: owner off,
 * owner on (5:30 PM), staff read-only, and unreadable. Rendered to HTML.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("../actions", () => ({ saveBookingCutoffAction: vi.fn() }));

import { BookingCutoffPanel } from "./BookingCutoffSettings";

const OFF = { cutoff_enabled: false, cutoff_time: "15:00", updated_at: null };
const ON = { cutoff_enabled: true, cutoff_time: "17:30", updated_at: "2026-11-11T20:00:00Z" };

describe("Order cutoff panel", () => {
  it("owner, off (as shipped)", () => {
    expect(renderToStaticMarkup(<BookingCutoffPanel settings={OFF} canEdit />)).toMatchSnapshot();
  });

  it("owner, on at 5:30 PM", () => {
    const html = renderToStaticMarkup(<BookingCutoffPanel settings={ON} canEdit />);
    expect(html).toMatch(/<option value="17:30" selected="">5:30 PM<\/option>/);
    expect(html).toMatchSnapshot();
  });

  it("staff, read-only", () => {
    expect(renderToStaticMarkup(<BookingCutoffPanel settings={ON} canEdit={false} />)).toMatchSnapshot();
  });

  it("unreadable", () => {
    expect(renderToStaticMarkup(<BookingCutoffPanel settings={null} canEdit />)).toMatchSnapshot();
  });

  it("the time picker offers exactly 3:00 AM to 11:45 PM in 15-minute steps", () => {
    const html = renderToStaticMarkup(<BookingCutoffPanel settings={OFF} canEdit />);
    const values = Array.from(html.matchAll(/<option value="([0-9:]+)"/g)).map((m) => m[1]);
    expect(values).toHaveLength(84);
    expect([values[0], values[1], values.at(-1)]).toEqual(["03:00", "03:15", "23:45"]);
  });
});
