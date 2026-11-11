/**
 * Unit test for runQuoBackfill (lib/cron/jobs.ts): the wiring between the
 * backfill and the real clients. The Supabase service client and the Quo
 * client are fakes; nothing reaches Quo or the database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpcCalls: Array<[string, Record<string, unknown>]> = [];
const selects: Array<{ table: string; columns: string; ids: string[] }> = [];
let selectError: { code: string } | null = null;
let rpcError: { code: string } | null = null;
let stored: Array<Record<string, unknown>> = [];
const quoOptions: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args]);
      return { data: null, error: rpcError };
    },
    from: (table: string) => ({
      select: (columns: string) => ({
        in: async (_col: string, ids: string[]) => {
          selects.push({ table, columns, ids });
          return { data: selectError ? null : stored, error: selectError };
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/call-log/quo-api", async (orig) => {
  const real = await orig<typeof import("@/lib/call-log/quo-api")>();
  return {
    ...real,
    createQuoClient: (opts: Record<string, unknown>) => {
      quoOptions.push(opts);
      let requests = 0;
      return {
        get requests() {
          return requests;
        },
        getPage: async (path: string) => {
          requests++;
          if (path === "/calls")
            return {
              data: [{ id: "AC1", status: "completed", direction: "incoming", duration: 0, participants: [], createdAt: "2026-11-10T10:00:00Z" }],
              nextCursor: null,
            };
          return { data: [], nextCursor: null };
        },
      };
    },
  };
});
vi.mock("@/lib/notifications/notify", () => ({}));
vi.mock("@/lib/quickbooks/tokens", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("@/lib/quickbooks/invoices", () => ({ syncInvoiceForBooking: vi.fn() }));
vi.mock("@/lib/quickbooks/invoice-payments", () => ({ reconcileInvoicePayments: vi.fn() }));
vi.mock("@/lib/quickbooks/config", () => ({ quickBooksConfigured: () => false, missingQuickBooksEnv: () => [] }));

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  rpcCalls.length = 0;
  selects.length = 0;
  quoOptions.length = 0;
  selectError = null;
  rpcError = null;
  stored = [];
  for (const k of ["CL_QUO_BACKFILL_ENABLED", "QUO_API_KEY"]) saved[k] = process.env[k];
  process.env.CL_QUO_BACKFILL_ENABLED = "1";
  process.env.QUO_API_KEY = "quo_test_key";
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("runQuoBackfill wiring", () => {
  it("builds the throttled client with the 300-request cap, reads rows in one select, ingests with p_source 'backfill'", async () => {
    const { runQuoBackfill } = await import("./jobs");
    const r = await runQuoBackfill();
    expect(r).toMatchObject({ ok: true, written: 1 });
    expect(quoOptions).toEqual([{ key: "quo_test_key", maxRequests: 300, minIntervalMs: 200 }]);
    expect(selects).toEqual([
      {
        table: "call_transcripts",
        columns: "quo_call_id, call_status, summary, voicemail_transcript, transcript, transcript_segments, transcript_purged_at",
        ids: ["AC1"],
      },
    ]);
    expect(rpcCalls).toHaveLength(1);
    const [name, args] = rpcCalls[0];
    expect(name).toBe("ingest_quo_call_event");
    expect(args).toMatchObject({ p_call_id: "AC1", p_source: "backfill" });
    expect(String(args.p_webhook_id)).toMatch(/^backfill:\d{4}-\d{2}-\d{2}$/);
  });

  it("a purged row is skipped: no ingest", async () => {
    stored = [{ quo_call_id: "AC1", call_status: "completed", transcript_purged_at: "2026-05-01T00:00:00Z" }];
    const { runQuoBackfill } = await import("./jobs");
    expect(await runQuoBackfill()).toMatchObject({ ok: true, written: 0, skipped_purged: 1 });
    expect(rpcCalls).toEqual([]);
  });

  it("database errors come back as ok:false with the code; never thrown", async () => {
    const { runQuoBackfill } = await import("./jobs");
    selectError = { code: "42P01" };
    expect(await runQuoBackfill()).toMatchObject({ ok: false, error: "db_42P01" });
    selectError = null;
    rpcError = { code: "42501" };
    expect(await runQuoBackfill()).toMatchObject({ ok: false, error: "db_42501" });
  });

  it("flag off: no client, no select, no write", async () => {
    process.env.CL_QUO_BACKFILL_ENABLED = "";
    const { runQuoBackfill } = await import("./jobs");
    expect(await runQuoBackfill()).toMatchObject({ ok: true, enabled: false });
    expect(quoOptions).toEqual([]);
    expect(selects).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("flag on, no QUO_API_KEY: not_configured, no client, no select, no write", async () => {
    delete process.env.QUO_API_KEY;
    const { runQuoBackfill } = await import("./jobs");
    expect(await runQuoBackfill()).toMatchObject({ ok: false, error: "not_configured", missing: ["QUO_API_KEY"] });
    expect(quoOptions).toEqual([]);
    expect(selects).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });
});
