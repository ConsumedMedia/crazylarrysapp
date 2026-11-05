/**
 * Driver app job scoping. The fake database below applies RLS the way the
 * real one does: a staff/owner session matches "jobs: staff full access" and
 * sees every job; a plain driver session sees only jobs assigned to their own
 * drivers row ("jobs: driver reads assigned jobs"). Every driver-app read and
 * the completion path must then return/act on the signed-in driver's own jobs
 * only, for both kinds of account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Job = { id: string; driver_id: string | null; scheduled_date: string; status: string; type: string; route_order: number | null };

const OWNER_DRIVER = { userId: "p-owner", driverId: "d-owner", fullName: "Owner Driver", active: true, staff: true };
const PLAIN_DRIVER = { userId: "p-plain", driverId: "d-plain", fullName: "Plain Driver", active: true, staff: false };
let me = OWNER_DRIVER;

const TODAY = "2026-11-05";
const JOBS: Job[] = [
  { id: "j-owner-today", driver_id: "d-owner", scheduled_date: TODAY, status: "assigned", type: "delivery", route_order: 1 },
  { id: "j-plain-today", driver_id: "d-plain", scheduled_date: TODAY, status: "assigned", type: "delivery", route_order: 1 },
  { id: "j-other-today", driver_id: "d-other", scheduled_date: TODAY, status: "assigned", type: "pickup", route_order: 2 },
  { id: "j-unassigned", driver_id: null, scheduled_date: TODAY, status: "unassigned", type: "delivery", route_order: null },
  { id: "j-owner-done", driver_id: "d-owner", scheduled_date: "2026-11-03", status: "completed", type: "pickup", route_order: 1 },
  { id: "j-other-done", driver_id: "d-other", scheduled_date: "2026-11-03", status: "completed", type: "pickup", route_order: 1 },
];

/** RLS: what a session can see at all. */
const visible = () => JOBS.filter((j) => me.staff || j.driver_id === me.driverId);

const row = (j: Job) => ({
  ...j,
  completed_at: j.status === "completed" ? `${j.scheduled_date}T15:00:00Z` : null,
  booking_id: `b-${j.id}`,
  job_photos: [],
  bookings: {
    size_requested: "15yd",
    delivery_address: "addr",
    debris_type: null,
    placement_notes: null,
    job_tags: [],
    job_tags_confirmed_at: null,
    status: "confirmed",
    dumpster_id: null,
    payment_status: "paid",
    delivery_date: j.scheduled_date,
    dumpsters: null,
    customers: { full_name: "c", phone: null, company_name: null },
  },
});

const rpcCalls: Array<{ name: string; args: unknown }> = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Array<(j: Job) => boolean> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: keyof Job, v: unknown) => (filters.push((j) => j[col] === v), b);
      b.neq = (col: keyof Job, v: unknown) => (filters.push((j) => j[col] !== v), b);
      b.gte = (col: keyof Job, v: string) => (filters.push((j) => String(j[col]) >= v), b);
      b.order = () => b;
      const result = () => {
        if (table === "trucks") return [];
        return visible().filter((j) => filters.every((f) => f(j)));
      };
      b.maybeSingle = async () => {
        const r = result();
        return { data: r[0] ? (table === "jobs" ? row(r[0] as Job) : r[0]) : null, error: null };
      };
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: result().map((j) => (table === "jobs" ? row(j as Job) : j)), error: null }).then(res);
      return b;
    },
    rpc: async (name: string, args: { p_job_id: string }) => {
      rpcCalls.push({ name, args });
      // complete_job's own check: is_staff() OR owns the job.
      const j = JOBS.find((x) => x.id === args.p_job_id);
      if (!j) return { data: null, error: { code: "P0002", message: "not found" } };
      if (!(me.staff || j.driver_id === me.driverId)) return { data: null, error: { code: "42501", message: "no" } };
      return { data: { id: j.id, type: j.type, booking_id: `b-${j.id}` }, error: null };
    },
  }),
}));
vi.mock("@/lib/auth/requireDriver", () => ({
  requireDriver: async () => ({ userId: me.userId, driverId: me.driverId, fullName: me.fullName, active: me.active }),
}));
vi.mock("@/lib/auth/requireStaff", () => ({ requireStaff: async () => ({}) }));
const notifyJobComplete = vi.fn(async (job: unknown) => void job);
vi.mock("@/lib/notifications/notify", () => ({ notifyJobComplete: (j: unknown) => notifyJobComplete(j) }));

import { myJobs, myJob, myTodaySummary, myRecentCompleted } from "./queries";
import { completeMyJob } from "./mutations";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T17:00:00.000Z"));
  rpcCalls.length = 0;
  notifyJobComplete.mockClear();
});
afterEach(() => vi.useRealTimers());

const ids = (js: Array<{ id: string }>) => js.map((j) => j.id).sort();

describe("owner who is also a driver: only their own jobs", () => {
  beforeEach(() => {
    me = OWNER_DRIVER;
  });
  it("myJobs: today's list is only theirs", async () => {
    expect(ids((await myJobs(TODAY)).jobs)).toEqual(["j-owner-today"]);
  });
  it("myJob: someone else's job is null (404); their own opens", async () => {
    expect(await myJob("j-other-today")).toBeNull();
    expect(await myJob("j-unassigned")).toBeNull();
    expect((await myJob("j-owner-today"))?.id).toBe("j-owner-today");
  });
  it("myTodaySummary: 'left today' counts only their own", async () => {
    const s = await myTodaySummary();
    expect(s.jobsToGo + s.jobsDone).toBe(1);
    expect(s.userId).toBe("p-owner");
  });
  it("myRecentCompleted (Done tab): only theirs", async () => {
    expect(ids(await myRecentCompleted(7))).toEqual(["j-owner-done"]);
  });
  it("completing another driver's job is refused before complete_job runs", async () => {
    await expect(completeMyJob("j-other-today")).rejects.toThrow("This job isn't assigned to you.");
    expect(rpcCalls).toEqual([]);
    expect(notifyJobComplete).not.toHaveBeenCalled();
  });
  it("completing their own job goes through", async () => {
    await completeMyJob("j-owner-today");
    expect(rpcCalls).toEqual([{ name: "complete_job", args: { p_job_id: "j-owner-today" } }]);
  });
});

describe("plain driver: unchanged (RLS already gave exactly these rows)", () => {
  beforeEach(() => {
    me = PLAIN_DRIVER;
  });
  it("myJobs equals what RLS alone returns for the day", async () => {
    const rlsOnly = visible().filter((j) => j.scheduled_date === TODAY && j.status !== "cancelled");
    expect(ids((await myJobs(TODAY)).jobs)).toEqual(ids(rlsOnly));
    expect(ids(rlsOnly)).toEqual(["j-plain-today"]);
  });
  it("myJob, summary and Done tab behave as before", async () => {
    expect((await myJob("j-plain-today"))?.id).toBe("j-plain-today");
    expect(await myJob("j-other-today")).toBeNull();
    const s = await myTodaySummary();
    expect(s.jobsToGo).toBe(1);
    expect(await myRecentCompleted(7)).toEqual([]);
  });
  it("completes their own job; another's is refused", async () => {
    await completeMyJob("j-plain-today");
    expect(rpcCalls.map((c) => c.args)).toEqual([{ p_job_id: "j-plain-today" }]);
    await expect(completeMyJob("j-other-today")).rejects.toThrow("This job isn't assigned to you.");
    expect(rpcCalls).toHaveLength(1);
  });
});
