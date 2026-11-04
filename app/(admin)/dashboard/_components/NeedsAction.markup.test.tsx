/**
 * Pins the exact HTML of the dashboard's Needs action panel today. Written
 * BEFORE the failed-refund group (step d, commit 5): with no failed refunds the
 * panel must stay byte-identical.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsAction } from "./NeedsAction";

describe("NeedsAction markup (no failed refunds)", () => {
  it("nothing to do", () => {
    expect(renderToStaticMarkup(<NeedsAction overdueBookings={[]} unassignedJobs={[]} />)).toMatchSnapshot();
  });
  it("overdue and unassigned", () => {
    expect(
      renderToStaticMarkup(
        <NeedsAction
          overdueBookings={[{ bookingId: "bk-1", address: "12 Test St", pickupDate: "2026-11-02", customerName: "Pat Example" }]}
          unassignedJobs={[
            { jobId: "job-1", bookingId: "bk-2", type: "delivery", scheduledDate: "2026-11-06", address: "7 Today Rd", customerName: "Lee Prepaid" },
          ]}
        />,
      ),
    ).toMatchSnapshot();
  });
});
