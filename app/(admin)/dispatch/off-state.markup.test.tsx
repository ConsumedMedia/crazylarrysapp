/**
 * Pins the exact HTML /dispatch renders today, with jobs that are not
 * due-and-unpaid. Written BEFORE the delivery-day warning (step d, commit 4):
 * for these jobs the page must stay byte-identical.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock } from "@/test/form-hooks";
import { NOT_DUE_JOBS } from "@/test/fixtures/dispatch-jobs";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dispatch",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({ id: "staff-1", role: "owner" }) }));
vi.mock("./actions", () => ({
  assignJobAction: vi.fn(),
  unassignJobAction: vi.fn(),
  reorderAction: vi.fn(),
  confirmTagsAction: vi.fn(),
}));
vi.mock("../schedule/actions", () => ({ createBlockAction: vi.fn(), deleteBlockAction: vi.fn() }));
vi.mock("@/lib/availability/blocks", () => ({ listBlocks: async () => [] }));
vi.mock("@/lib/dispatch/queries", () => ({
  listUnassignedJobs: async () => NOT_DUE_JOBS.filter((j) => j.status === "unassigned"),
  listDrivers: async () => [
    {
      id: "drv-1",
      profile_id: "p-1",
      full_name: "Marcus Driver",
      phone: null,
      vehicle_info: null,
      active: true,
      truck_id: null,
      truck_nickname: null,
      truck_status: null,
    },
  ],
  listAvailableUnits: async () => [],
  listDriverJobs: async () => NOT_DUE_JOBS.filter((j) => j.driver_id === "drv-1"),
  checkMatrix: async () => ({}),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());

describe("/dispatch markup (nothing due and unpaid)", () => {
  it("queue and today's driver lane", async () => {
    const { default: Page } = await import("./page");
    expect(renderToStaticMarkup(await Page({ searchParams: {} }))).toMatchSnapshot();
  });
});
