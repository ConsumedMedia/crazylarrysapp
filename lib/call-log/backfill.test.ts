/**
 * Unit test for the Quo backfill. Quo is ALWAYS a fake here: either a fake
 * client (getPage) or the real throttled client over a fake fetch. The
 * database is an in-memory stand-in with the same fill-only rule as
 * ingest_quo_call_event(..., 'backfill'): one ingest = one atomic write, like
 * one RPC = one transaction. All values are fictional.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  backfillOnce,
  backfillWindow,
  existingRowsFrom,
  needsTranscript,
  runBackfill,
  BackfillDbError,
  BACKFILL_MAX_CALLS,
  type BackfillDeps,
  type BackfillEvent,
} from "./backfill";
import { createQuoClient, QuoApiError } from "./quo-api";
import { mapQuoEvent, type IngestFields } from "./quo-events";
import type { QuoRestCall, QuoRestTranscript } from "./quo-rest";
import { QUO_YARD_PHONE_NUMBER_ID } from "./config";
import { REDACTED_CARD } from "./redact";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const CARD = "4111 1111 1111 1111";
const KEY = "quo_test_key_" + "k".repeat(24);

// --- fixtures -----------------------------------------------------------------

const answered = (n: number, over: Partial<QuoRestCall> = {}): QuoRestCall => ({
  id: `AC${n}`,
  phoneNumberId: QUO_YARD_PHONE_NUMBER_ID,
  direction: "incoming",
  status: "completed",
  participants: [
    { phoneNumber: "+16145550100", actorId: "USlarry" },
    { phoneNumber: `+1614555${String(1000 + n).slice(-4)}`, actorId: null },
  ],
  createdAt: new Date(NOW - n * 3_600_000).toISOString(),
  completedAt: new Date(NOW - n * 3_600_000 + 60_000).toISOString(),
  duration: 60,
  summary: { status: "completed", summary: [`Call ${n} summary`, `Read ${CARD}`], nextSteps: [`Step ${n}`] },
  ...over,
});
const transcriptsFor = (n: number, segments = 1): QuoRestTranscript[] =>
  Array.from({ length: segments }, (_, i) => ({
    recordingId: `CR${n}_${i}`,
    status: "completed",
    startTime: new Date(NOW - n * 3_600_000 + i * 120_000).toISOString(),
    createdAt: new Date(NOW - n * 3_600_000 + i * 120_000 + 90_000).toISOString(),
    duration: 30,
    dialogue: [
      { actorId: "USlarry", identifier: "+16145550100", content: `Call ${n} part ${i} staff`, start: 0, end: 2 },
      { actorId: null, identifier: "+16145559999", content: `Call ${n} part ${i} caller ${CARD}`, start: 3, end: 6 },
    ],
  }));

// --- fakes --------------------------------------------------------------------

type Hook = (op: string) => Promise<void> | void;

function fakeQuo(calls: QuoRestCall[], transcripts: Record<string, QuoRestTranscript[]>, pageSize = 50, hook?: Hook) {
  let requests = 0;
  const log: Array<{ path: string; query: Record<string, string | undefined> }> = [];
  const client: BackfillDeps["client"] = {
    get requests() {
      return requests;
    },
    async getPage<T>(path: string, query: Record<string, string | undefined> = {}) {
      await hook?.(`get ${path}`);
      requests++;
      log.push({ path, query });
      if (path === "/calls") {
        const start = query.after ? Number(query.after) : 0;
        const end = start + pageSize;
        return { data: calls.slice(start, end) as unknown as T[], nextCursor: end < calls.length ? String(end) : null };
      }
      const id = decodeURIComponent(path.split("/")[2]);
      return { data: (transcripts[id] ?? []) as unknown as T[], nextCursor: null };
    },
  };
  return { client, log };
}

type Row = Record<string, unknown>;
/** Same rule as the database for p_source 'backfill': fill empty fields; a REST set replaces the segments. */
function fakeDb(initial: Record<string, Row> = {}, hook?: Hook) {
  const rows = new Map<string, Row>(Object.entries(structuredClone(initial)));
  const ingests: Array<{ callId: string; runId: string; event: BackfillEvent }> = [];
  const readRows: BackfillDeps["readRows"] = async (ids) =>
    existingRowsFrom(ids.filter((id) => rows.has(id)).map((id) => ({ quo_call_id: id, ...rows.get(id) })));
  const ingest: BackfillDeps["ingest"] = async (callId, runId, event) => {
    await hook?.(`ingest ${callId}`);
    ingests.push({ callId, runId, event: structuredClone(event) });
    const cur = rows.get(callId) ?? {};
    if (cur.transcript_purged_at) return;
    const next: Row = { ...cur };
    for (const [k, v] of Object.entries(event)) {
      if (k === "transcript_segments") {
        next.transcript_segments = v;
        next.transcript = (v as Array<{ lines: Array<{ content: string }> }>).map((s) => s.lines.map((l) => l.content).join("\n")).join("\n--\n");
      } else if (next[k] == null) next[k] = v;
    }
    rows.set(callId, next); // one assignment: the whole call or nothing
  };
  return { rows, ingests, readRows, ingest };
}

function deps(q: ReturnType<typeof fakeQuo>, db: ReturnType<typeof fakeDb>, now: () => number = () => NOW): BackfillDeps {
  return { client: q.client, readRows: db.readRows, ingest: db.ingest, now };
}

const ON = { CL_QUO_BACKFILL_ENABLED: "1", QUO_API_KEY: KEY };

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./config");
});

// --- window -------------------------------------------------------------------

describe("window", () => {
  it("from now − 3 days to now − 30 minutes", () => {
    expect(backfillWindow(NOW)).toEqual({ from: "2026-11-07T12:00:00.000Z", to: "2026-11-10T11:30:00.000Z" });
  });

  it("never reaches past retention − 1 day, whatever the lookback", async () => {
    vi.doMock("./config", async (orig) => ({ ...(await orig<typeof import("./config")>()), TRANSCRIPT_RETENTION_DAYS: 3, QUO_BACKFILL_LOOKBACK_DAYS: 10 }));
    const { backfillWindow: w } = await import("./backfill");
    expect(w(NOW).from).toBe("2026-11-08T12:00:00.000Z"); // now − (3 − 1) days, not now − 10
  });

  it("the call list asks for the yard line, the window, summary + voicemail, 50 a page", async () => {
    const q = fakeQuo([answered(1)], { AC1: transcriptsFor(1) });
    await backfillOnce(deps(q, fakeDb()));
    expect(q.log[0]).toEqual({
      path: "/calls",
      query: {
        phoneNumberId: "PNXYakN6nP",
        "createdAt[gte]": "2026-11-07T12:00:00.000Z",
        "createdAt[lte]": "2026-11-10T11:30:00.000Z",
        include: "summary,voicemail",
        limit: "50",
        after: undefined,
      },
    });
  });

  it("run id is the YARD day: 10 PM Eastern on Nov 9 is still Nov 9 (UTC is already Nov 10)", async () => {
    const late = Date.parse("2026-11-10T03:00:00.000Z");
    const r = await backfillOnce(deps(fakeQuo([], {}), fakeDb(), () => late));
    expect(r.run_id).toBe("backfill:2026-11-09");
  });
});

// --- paging and caps ------------------------------------------------------------

describe("paging and caps", () => {
  it("follows nextCursor and stops at a null cursor", async () => {
    const calls = Array.from({ length: 7 }, (_, i) => answered(i + 1, { duration: 0 }));
    const q = fakeQuo(calls, {}, 3);
    const r = await backfillOnce(deps(q, fakeDb()));
    expect(q.log.filter((l) => l.path === "/calls").map((l) => l.query.after)).toEqual([undefined, "3", "6"]);
    expect(r).toMatchObject({ ok: true, stopped: "done", calls_seen: 7, written: 7 });
  });

  it(`writes at most ${BACKFILL_MAX_CALLS} calls, then stops cleanly and says what was left`, async () => {
    const calls = Array.from({ length: 130 }, (_, i) => answered(i + 1, { duration: 0 }));
    const db = fakeDb();
    const r = await backfillOnce(deps(fakeQuo(calls, {}, 50), db));
    expect(r).toMatchObject({ ok: true, stopped: "call_cap", written: 100, left: { calls_in_page: 30, more_pages: false } });
    expect(db.rows.size).toBe(100);
  });

  it("request cap: stops cleanly (ok) with what was left; nothing half-written", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => answered(i + 1));
    const t = Object.fromEntries(calls.map((c, i) => [c.id, transcriptsFor(i + 1)]));
    const real = fakeQuo(calls, t);
    let n = 0;
    const capped: BackfillDeps["client"] = {
      get requests() {
        return real.client.requests;
      },
      getPage: async (p, qy) => {
        if (++n > 3) throw new QuoApiError("request_cap", null, p);
        return real.client.getPage(p, qy);
      },
    };
    const db = fakeDb();
    const r = await backfillOnce({ client: capped, readRows: db.readRows, ingest: db.ingest, now: () => NOW });
    expect(r).toMatchObject({ ok: true, stopped: "request_cap", written: 2, left: { calls_in_page: 3, more_pages: false } });
    expect(Array.from(db.rows.keys())).toEqual(["AC1", "AC2"]);
  });

  it("time cap (60 s): stops before the next request or write, ok, and says what was left", async () => {
    let clock = NOW;
    const calls = Array.from({ length: 4 }, (_, i) => answered(i + 1));
    const q = fakeQuo(calls, Object.fromEntries(calls.map((c, i) => [c.id, transcriptsFor(i + 1)])), 50, () => {
      clock += 25_000;
    });
    const db = fakeDb();
    const r = await backfillOnce(deps(q, db, () => clock));
    expect(r).toMatchObject({ ok: true, stopped: "time_cap", written: 1 });
    expect(r.left?.calls_in_page).toBe(3);
  });

  it("throttle: the real client spaces the backfill's requests at least 200 ms apart (fake clock)", async () => {
    let clock = NOW;
    const at: number[] = [];
    const calls = [answered(1), answered(2)];
    const client = createQuoClient({
      key: KEY,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      fetch: async (url) => {
        at.push(clock);
        clock += 20; // each request takes 20 ms
        const path = new URL(url).pathname;
        const body = path === "/calls" ? { data: calls, nextCursor: null } : { data: transcriptsFor(1), nextCursor: null };
        return { status: 200, json: async () => body };
      },
    });
    const db = fakeDb();
    const r = await backfillOnce({ client, readRows: db.readRows, ingest: db.ingest, now: () => clock });
    expect(r.ok).toBe(true);
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(200);
  });

  it("429: backs off and retries, then stops with ok:false; nothing written", async () => {
    let clock = NOW;
    const slept: number[] = [];
    const client = createQuoClient({
      key: KEY,
      now: () => clock,
      random: () => 0.5,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      fetch: async () => ({ status: 429, json: async () => ({}) }),
    });
    const db = fakeDb();
    const r = await backfillOnce({ client, readRows: db.readRows, ingest: db.ingest, now: () => NOW });
    expect(r).toMatchObject({ ok: false, stopped: "error", error: "quo_rate_limited_429", requests: 4, written: 0 });
    expect(slept).toEqual([625, 1125, 2125]);
    expect(db.rows.size).toBe(0);
  });
});

// --- what is fetched and written ---------------------------------------------------

describe("what is fetched and written", () => {
  it("skips calls that aren't final, purged rows and complete rows, without fetching their transcripts", async () => {
    const calls = [
      answered(1, { status: "in-progress" }),
      answered(2),
      answered(3),
      answered(4),
    ];
    const db = fakeDb({
      AC2: { call_status: "completed", summary: "x", transcript: "x", transcript_purged_at: "2026-05-01T00:00:00Z" },
      AC3: {
        call_status: "completed",
        summary: "x",
        transcript: "x",
        transcript_segments: [{ key: "seg_a", recording_id: "CR3_0", lines: [] }],
      },
    });
    const q = fakeQuo(calls, { AC2: transcriptsFor(2), AC3: transcriptsFor(3), AC4: transcriptsFor(4) });
    const r = await backfillOnce(deps(q, db));
    expect(r).toMatchObject({ skipped_not_final: 1, skipped_purged: 1, already_complete: 1, written: 1, transcripts_fetched: 1 });
    expect(q.log.map((l) => l.path)).toEqual(["/calls", "/calls/AC4/transcripts"]);
    expect(db.ingests.map((i) => i.callId)).toEqual(["AC4"]);
    expect(db.rows.get("AC2")).toEqual({ call_status: "completed", summary: "x", transcript: "x", transcript_purged_at: "2026-05-01T00:00:00Z" });
  });

  it("fetches the REST transcripts for a row whose segments came from the webhook (no recording ids) or that has none", () => {
    const call = answered(1);
    const row = (o: Partial<ReturnType<typeof existingRowsFrom> extends Map<string, infer R> ? R : never>) => ({
      has_status: true, has_summary: true, has_voicemail_transcript: false, has_transcript: true,
      segment_count: 0, rest_segment_count: 0, purged: false, ...o,
    });
    expect(needsTranscript(call, undefined)).toBe(true);
    expect(needsTranscript(call, row({ segment_count: 0 }))).toBe(true);
    expect(needsTranscript(call, row({ segment_count: 2, rest_segment_count: 1 }))).toBe(true);
    expect(needsTranscript(call, row({ segment_count: 2, rest_segment_count: 2 }))).toBe(false);
    expect(needsTranscript(answered(1, { status: "missed" }), undefined)).toBe(false);
    expect(needsTranscript(answered(1, { duration: 0 }), undefined)).toBe(false);
  });

  it("a stored row whose segments came from the webhook (no recording id) still gets the REST set", async () => {
    const stored = {
      call_status: "completed",
      summary: "x",
      transcript: "x",
      transcript_segments: [
        { key: "seg_a", recording_id: "CR1_0", lines: [] },
        { key: "seg_b", recording_id: null, lines: [] },
      ],
    };
    expect(existingRowsFrom([{ quo_call_id: "AC1", ...stored }]).get("AC1")).toMatchObject({ segment_count: 2, rest_segment_count: 1 });
    const q = fakeQuo([answered(1)], { AC1: transcriptsFor(1, 2) });
    const db = fakeDb({ AC1: stored });
    const r = await backfillOnce(deps(q, db));
    expect(r).toMatchObject({ transcripts_fetched: 1, written: 1 });
    expect(db.ingests[0].event.transcript_segments?.map((s) => s.recording_id)).toEqual(["CR1_0", "CR1_1"]);
  });

  it("sends ONE fill-only ingest per call with the whole call: fields through the mapper, redacted, and the full REST set", async () => {
    const db = fakeDb();
    await backfillOnce(deps(fakeQuo([answered(1)], { AC1: transcriptsFor(1, 2) }), db));
    expect(db.ingests).toHaveLength(1);
    const { callId, runId, event } = db.ingests[0];
    expect(callId).toBe("AC1");
    expect(runId).toBe("backfill:2026-11-10");
    expect(event).toMatchObject({
      caller_number: "+16145551001",
      direction: "incoming",
      call_status: "completed",
      duration_seconds: 60,
      has_voicemail: false,
      quo_phone_number_id: "PNXYakN6nP",
      summary: `Call 1 summary\nRead ${REDACTED_CARD}`,
      next_steps: ["Step 1"],
    });
    expect(event.transcript).toBeUndefined();
    expect(event.transcript_dialogue).toBeUndefined();
    expect(event.transcript_segments?.map((s) => [s.recording_id, s.order_at, s.duration])).toEqual([
      ["CR1_0", transcriptsFor(1, 2)[0].startTime, 30],
      ["CR1_1", transcriptsFor(1, 2)[1].startTime, 30],
    ]);
    expect(JSON.stringify(event)).not.toContain("4111");
  });

  it("a transcript still in progress: the call is written without a set (the next run fetches it again); failed ones are skipped", async () => {
    const t = transcriptsFor(1, 3);
    t[1] = { ...t[1], status: "in-progress", dialogue: null };
    const db = fakeDb();
    const r = await backfillOnce(deps(fakeQuo([answered(1)], { AC1: t }), db));
    expect(r.transcripts_pending).toBe(1);
    expect(db.ingests[0].event.transcript_segments).toBeUndefined();

    const t2 = transcriptsFor(1, 3);
    t2[1] = { ...t2[1], status: "failed", dialogue: null };
    const db2 = fakeDb();
    await backfillOnce(deps(fakeQuo([answered(1)], { AC1: t2 }), db2));
    expect(db2.ingests[0].event.transcript_segments?.map((s) => s.recording_id)).toEqual(["CR1_0", "CR1_2"]);
  });

  it("a backfill never overwrites what the webhook stored (fill-only)", async () => {
    const db = fakeDb({ AC1: { call_status: "answered", summary: "Webhook summary", caller_number: "+16145550000" } });
    await backfillOnce(deps(fakeQuo([answered(1)], { AC1: transcriptsFor(1) }), db));
    expect(db.rows.get("AC1")).toMatchObject({ call_status: "answered", summary: "Webhook summary", caller_number: "+16145550000", duration_seconds: 60 });
  });
});

// --- errors and configuration ---------------------------------------------------------

describe("errors and configuration", () => {
  it.each([
    ["unauthorized", 401, "quo_unauthorized_401"],
    ["http", 500, "quo_http_500"],
    ["network", null, "quo_network"],
    ["timeout", null, "quo_timeout"],
    ["bad_response", 200, "quo_bad_response_200"],
  ] as const)("Quo %s: ok:false with the code only, nothing written, never throws", async (kind, status, code) => {
    const client: BackfillDeps["client"] = { requests: 1, getPage: async (p) => { throw new QuoApiError(kind, status, p); } };
    const db = fakeDb();
    const r = await backfillOnce({ client, readRows: db.readRows, ingest: db.ingest, now: () => NOW });
    expect(r).toMatchObject({ ok: false, stopped: "error", error: code, written: 0 });
  });

  it("a database error on the select or the write: ok:false db_<code>, the run stops", async () => {
    const q = fakeQuo([answered(1), answered(2)], { AC1: transcriptsFor(1), AC2: transcriptsFor(2) });
    const db = fakeDb();
    const r1 = await backfillOnce({ ...deps(q, db), readRows: async () => { throw new BackfillDbError("42501"); } });
    expect(r1).toMatchObject({ ok: false, error: "db_42501", written: 0 });
    let n = 0;
    const r2 = await backfillOnce({ ...deps(q, db), ingest: async (id, run, ev) => { if (++n === 2) throw new BackfillDbError("57014"); await db.ingest(id, run, ev); } });
    expect(r2).toMatchObject({ ok: false, error: "db_57014", written: 1 });
  });

  it("flag honoured only for exactly '1': otherwise nothing is built, fetched or written", async () => {
    for (const v of [undefined, "", "0", "true", " 1", "yes"]) {
      const make = vi.fn();
      expect(await runBackfill(make, { CL_QUO_BACKFILL_ENABLED: v, QUO_API_KEY: KEY })).toMatchObject({ ok: true, enabled: false, written: 0 });
      expect(make).not.toHaveBeenCalled();
    }
  });

  it("flag on, QUO_API_KEY missing or blank: ok:false not_configured naming the variable; no client, no request, no write", async () => {
    for (const key of [undefined, "", "   "]) {
      const make = vi.fn();
      expect(await runBackfill(make, { CL_QUO_BACKFILL_ENABLED: "1", QUO_API_KEY: key })).toMatchObject({
        ok: false, enabled: true, error: "not_configured", missing: ["QUO_API_KEY"], requests: 0, written: 0,
      });
      expect(make).not.toHaveBeenCalled();
    }
  });

  it("flag on, a malformed yard line id: not_configured naming it; nothing built", async () => {
    vi.doMock("./config", async (orig) => ({ ...(await orig<typeof import("./config")>()), QUO_YARD_PHONE_NUMBER_ID: "not-a-pn" }));
    const { runBackfill: run } = await import("./backfill");
    const make = vi.fn();
    expect(await run(make, ON)).toMatchObject({ ok: false, error: "not_configured", missing: ["QUO_YARD_PHONE_NUMBER_ID"] });
    expect(make).not.toHaveBeenCalled();
  });

  it("the result carries counts and codes only: no phone number, call text or key", async () => {
    const db = fakeDb();
    const r = await runBackfill(() => deps(fakeQuo([answered(1)], { AC1: transcriptsFor(1) }), db), ON);
    expect(r.ok).toBe(true);
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/\+1614|555|4111|summary|part|staff|caller|Step/i);
    expect(json).not.toContain(KEY);
  });
});

// --- interruption -------------------------------------------------------------------

describe("interrupted run", () => {
  const calls = [answered(1), answered(2, { status: "missed", duration: 0, summary: null }), answered(3), answered(4, { status: "ringing" }), answered(5)];
  const transcripts = { AC1: transcriptsFor(1, 2), AC3: transcriptsFor(3), AC5: transcriptsFor(5, 3) };
  const flush = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };

  it("cut off at EVERY point (a hung request or write = Vercel ending the function): each row is complete or absent, and a rerun completes it", async () => {
    const reference = fakeDb();
    const full = await backfillOnce(deps(fakeQuo(calls, transcripts, 2), reference));
    expect(full).toMatchObject({ ok: true, stopped: "done", written: 4 });
    const ops = full.requests + full.written; // every request and every write

    for (let k = 0; k <= ops; k++) {
      let n = 0;
      const hang: Hook = () => (n++ === k ? new Promise<void>(() => {}) : undefined);
      const db = fakeDb({}, hang);
      void backfillOnce(deps(fakeQuo(calls, transcripts, 2, hang), db));
      await flush();
      for (const [id, stored] of Array.from(db.rows)) expect({ k, id, stored }).toEqual({ k, id, stored: reference.rows.get(id) });

      const rerun = fakeDb(Object.fromEntries(db.rows));
      const r = await backfillOnce(deps(fakeQuo(calls, transcripts, 2), rerun));
      expect(r.ok).toBe(true);
      expect(Object.fromEntries(rerun.rows)).toEqual(Object.fromEntries(reference.rows));
      // The rerun only wrote what the cut-off run hadn't.
      expect(rerun.ingests.map((i) => i.callId).sort()).toEqual(Array.from(reference.rows.keys()).filter((id) => !db.rows.has(id)).sort());
    }
  });

  it("a time-cap stop part-way also leaves only complete rows, and the next run finishes", async () => {
    let clock = NOW;
    const db = fakeDb();
    const r = await backfillOnce(deps(fakeQuo(calls, transcripts, 2, () => void (clock += 21_000)), db, () => clock));
    expect(r.stopped).toBe("time_cap");
    const reference = fakeDb();
    await backfillOnce(deps(fakeQuo(calls, transcripts, 2), reference));
    for (const [id, stored] of Array.from(db.rows)) expect(stored).toEqual(reference.rows.get(id));
    expect(db.rows.size).toBeLessThan(reference.rows.size);
    await backfillOnce(deps(fakeQuo(calls, transcripts, 2), db));
    expect(Object.fromEntries(db.rows)).toEqual(Object.fromEntries(reference.rows));
  });
});

// --- REST and webhook agree -------------------------------------------------------------

describe("REST and webhook produce the same stored fields for the same call", () => {
  it("call, summary and transcript: identical fields, and the REST set's lines are the webhook's dialogue", async () => {
    const call = answered(7);
    const [t] = transcriptsFor(7);
    const context = {
      orgId: "ORyard",
      phoneNumberId: QUO_YARD_PHONE_NUMBER_ID,
      participants: { workspace: ["+16145550100"], external: ["+16145551007"], resolution: "available" },
    };
    const hook = (type: string, resource: object) => mapQuoEvent({ type, data: { resource, context } });
    const webhookEvents = [
      hook("call.completed", { id: call.id, direction: "incoming", status: "completed", createdAt: call.createdAt, duration: 60, hasVoicemail: false }),
      hook("call.summary.completed", { callId: call.id, processingStatus: "completed", summary: call.summary!.summary, nextSteps: call.summary!.nextSteps }),
      hook("call.transcript.completed", {
        callId: call.id, createdAt: t.createdAt, duration: 30, processingStatus: "completed",
        dialogue: t.dialogue!.map((d) => ({ userId: d.actorId, identifier: d.identifier, content: d.content, start: d.start, end: d.end })),
      }),
    ];
    const webhookFields: IngestFields = {};
    for (const m of webhookEvents) if (m.kind === "ingest") Object.assign(webhookFields, m.fields);

    const db = fakeDb();
    await backfillOnce(deps(fakeQuo([call], { [call.id]: [t] }), db));
    const { transcript_segments, ...restFields } = db.ingests[0].event;
    const { transcript, transcript_dialogue, ...hookRest } = webhookFields;
    expect(restFields).toEqual(hookRest);
    expect(transcript_segments).toHaveLength(1);
    expect(transcript_segments![0].lines).toEqual(transcript_dialogue);
    expect(transcript).toBe(transcript_segments![0].lines.map((l) => `${l.speaker === "staff" ? "Staff" : "Caller"}: ${l.content}`).join("\n"));
  });
});
