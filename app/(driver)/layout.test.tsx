/**
 * Driver header: "Admin view" (to /dashboard) appears only for staff/owner
 * accounts that also have a drivers row; a plain driver never sees it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/driver" }));
let staff = false;
const hasStaffRole = vi.fn(async (userId: string) => (void userId, staff));
vi.mock("@/lib/auth/modes", () => ({ hasStaffRole: (id: string) => hasStaffRole(id) }));
vi.mock("@/lib/driver/queries", () => ({
  myTodaySummary: async () => ({
    userId: "p-1",
    driverName: "Test Driver",
    active: true,
    truckNickname: null,
    date: "2026-11-05",
    jobsDone: 0,
    jobsToGo: 2,
  }),
}));

import DriverLayout from "./layout";

const render = async () => renderToStaticMarkup(await DriverLayout({ children: <p>page</p> }));

beforeEach(() => hasStaffRole.mockClear());

describe("driver header", () => {
  it("staff/owner driver: 'Admin view' links to /dashboard, checked for the signed-in account", async () => {
    staff = true;
    const html = await render();
    expect(html).toMatch(/<a [^>]*href="\/dashboard"[^>]*>Admin view<\/a>/);
    expect(hasStaffRole).toHaveBeenCalledWith("p-1");
    expect(html).toContain("left today");
  });
  it("plain driver: no 'Admin view'", async () => {
    staff = false;
    const html = await render();
    expect(html).not.toContain("Admin view");
    expect(html).not.toContain('href="/dashboard"');
  });
});
