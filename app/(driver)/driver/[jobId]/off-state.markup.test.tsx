/**
 * Pins the exact HTML of the driver's job page today, for jobs that are not
 * due-and-unpaid. Written BEFORE the delivery-day warning (step d, commit 4):
 * for these jobs the page must stay byte-identical.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_DUE_JOBS } from "@/test/fixtures/dispatch-jobs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("../actions", () => ({ completeJobAction: vi.fn() }));

const lane = NOT_DUE_JOBS.filter((j) => j.driver_id === "drv-1");
vi.mock("@/lib/driver/queries", () => ({
  myJob: async (id: string) => NOT_DUE_JOBS.find((j) => j.id === id) ?? null,
  myJobs: async () => ({ jobs: lane }),
}));

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T17:00:00.000Z"));
  process.env.CL_YARD_PHONE = "+16145550100";
});
afterAll(() => vi.useRealTimers());

async function render(jobId: string) {
  const { default: Page } = await import("./page");
  return renderToStaticMarkup(await Page({ params: { jobId } }));
}

describe("/driver/[jobId] markup (not due and unpaid)", () => {
  it("delivery today for a paid booking", async () => {
    expect(await render("job-c")).toMatchSnapshot();
  });
  it("pickup today for a paid booking", async () => {
    expect(await render("job-b")).toMatchSnapshot();
  });
});
