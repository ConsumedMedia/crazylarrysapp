import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formHooksMock, formActionsUsed, formStateFor } from "@/test/form-hooks";
import { NeedsAction } from "./_components/NeedsAction";
import { ResolveRefundStep } from "./_components/ResolveRefundButton";
import { resolveRefundAction } from "./actions";

vi.mock("react-dom", async (orig) => formHooksMock(await orig<object>()));
vi.mock("./actions", () => ({ resolveRefundAction: vi.fn() }));

const FAILED = [
  { id: "a1", createdAt: "2026-11-04T15:00:00Z", amount: 375.38, chargeId: "CH-1", reason: "booking changed", bookingId: "bk-1", source: "pay_link" as const },
  { id: "a2", createdAt: "2026-11-03T15:00:00Z", amount: null, chargeId: null, reason: null, bookingId: null, source: "checkout" as const },
];

beforeEach(() => {
  formActionsUsed.length = 0;
  formStateFor.clear();
});

describe("Needs action — failed refunds", () => {
  it("lists each with amount, when, source, charge, booking link and a Mark resolved button", () => {
    const html = renderToStaticMarkup(<NeedsAction overdueBookings={[]} unassignedJobs={[]} failedRefunds={FAILED} />);
    expect(html).toContain("Refund failed — fix in QuickBooks (2)");
    expect(html).toContain("$375.38 charged, not refunded");
    expect(html).toContain("Pay link · charge CH-1 · booking changed");
    expect(html).toContain('href="/bookings/bk-1"');
    expect(html).toContain("Amount unknown charged, not refunded");
    expect(html).toContain("Online checkout");
    expect(html.split(">Mark resolved</button>").length - 1).toBe(2);
    expect(html).not.toContain("Nothing needs attention right now.");
    expect(formActionsUsed.every((a) => a === resolveRefundAction)).toBe(true);
  });

  it("first step is only a button; the second step says what it records and has the id", () => {
    const step = (stage: "idle" | "confirm") =>
      renderToStaticMarkup(<ResolveRefundStep id="a1" stage={stage} onAsk={() => {}} onCancel={() => {}} action={() => {}} />);
    expect(step("idle")).not.toContain("<form");
    const c = step("confirm");
    expect(c).toContain("This records you and the time.");
    expect(c).toContain("Yes, mark resolved");
    expect(c).toContain('name="id" value="a1"');
  });

  it("after resolving, the row says Resolved", () => {
    formStateFor.set(resolveRefundAction, { ok: true });
    const html = renderToStaticMarkup(<NeedsAction overdueBookings={[]} unassignedJobs={[]} failedRefunds={[FAILED[0]]} />);
    expect(html).toContain(">Resolved<");
    expect(html).not.toContain("Mark resolved");
  });
});
