/**
 * Unit test for /api/cron/daily: one job failing — by reporting ok:false or by
 * throwing — never stops the jobs after it, and the response says which one
 * failed. The jobs themselves are fakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const ran: string[] = [];
const behaviour: Record<string, "ok" | "not_ok" | "throw"> = {};
const job = (name: string) => async () => {
  ran.push(name);
  const b = behaviour[name] ?? "ok";
  if (b === "throw") throw new Error(`${name} exploded`);
  return b === "not_ok" ? { ok: false, error: `${name}_failed` } : { ok: true };
};

vi.mock("@/lib/cron/jobs", () => ({
  runOverdue: job("overdue"),
  runReminders: job("reminders"),
  runPayLinks: job("pay_links"),
  runQuickbooksRefresh: job("quickbooks_refresh"),
  runQuickbooksSync: job("quickbooks_sync"),
  runCallTranscriptPurge: job("call_transcript_purge"),
  runQuoBackfill: job("quo_backfill"),
}));

const ALL = ["overdue", "reminders", "pay_links", "quickbooks_refresh", "quickbooks_sync", "call_transcript_purge", "quo_backfill"];
let saved: string | undefined;

beforeEach(() => {
  ran.length = 0;
  for (const k of Object.keys(behaviour)) delete behaviour[k];
  saved = process.env.CL_CRON_SECRET;
  process.env.CL_CRON_SECRET = "test-secret";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.CL_CRON_SECRET;
  else process.env.CL_CRON_SECRET = saved;
  vi.restoreAllMocks();
});

async function run(auth = "Bearer test-secret") {
  const { GET } = await import("./route");
  const res = await GET(new NextRequest("http://localhost/api/cron/daily", { headers: { authorization: auth } }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; jobs: Record<string, { ok: boolean; error?: string }> } };
}

describe("/api/cron/daily", () => {
  it("wrong secret: 401 and no job runs", async () => {
    expect((await run("Bearer nope")).status).toBe(401);
    expect(ran).toEqual([]);
  });

  it("runs every job in order, the Quo backfill last", async () => {
    const r = await run();
    expect(ran).toEqual(ALL);
    expect(r.body.ok).toBe(true);
    expect(Object.keys(r.body.jobs)).toEqual(ALL);
  });

  it.each(["call_transcript_purge", "quo_backfill"])("%s reporting ok:false fails only its own entry", async (name) => {
    behaviour[name] = "not_ok";
    const r = await run();
    expect(ran).toEqual(ALL);
    expect(r.body.ok).toBe(false);
    expect(r.body.jobs[name]).toMatchObject({ ok: false, error: `${name}_failed` });
    for (const other of ALL.filter((n) => n !== name)) expect(r.body.jobs[other].ok).toBe(true);
  });

  it.each(ALL)("%s throwing: recorded as ok:false, every other job still runs", async (name) => {
    behaviour[name] = "throw";
    const r = await run();
    expect(ran).toEqual(ALL);
    expect(r.status).toBe(200);
    expect(r.body.jobs[name]).toEqual({ ok: false, error: `${name} exploded` });
    for (const other of ALL.filter((n) => n !== name)) expect(r.body.jobs[other].ok).toBe(true);
  });
});
