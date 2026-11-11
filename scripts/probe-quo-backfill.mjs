// Rolled-back probe: the backfill and the webhook writing the same calls, against the
// LIVE ingest_quo_call_event and purge_call_transcripts (migrations 20261110000000 and
// 20261110010000 must be applied; the probe refuses to run otherwise).
//
//   node --use-system-ca scripts/probe-quo-backfill.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally). Calls are
// fictional, ids 'ACprobe-<tag>-…', caller numbers 555-01xx. Quo is never called: the
// events below have the shapes lib/call-log/quo-events.ts (webhook) and
// lib/call-log/backfill.ts (backfill) send, which their unit tests pin.
// All calls are made as service_role, the role both the webhook route and the cron use.
// Real rows are fingerprinted before, inside and after. Prints counts and pass/fail only.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const TAG = crypto.randomUUID().slice(0, 8);
const id = (name) => `ACprobe-${TAG}-${name}`;
const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

async function svc(fn) {
  await c.query("set local role service_role");
  await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
  }
}
/** The webhook route's call: three named arguments, p_source left to its default. */
const webhook = (callId, event) =>
  svc(() => q(`select public.ingest_quo_call_event(p_call_id => $1, p_webhook_id => 'msg_probe', p_event => $2::jsonb)`, [callId, JSON.stringify(event)]));
/** The backfill's call: p_source 'backfill', run id as the webhook id. */
const backfill = (callId, event) =>
  svc(() => q(`select public.ingest_quo_call_event($1, 'backfill:2026-11-10', $2::jsonb, 'backfill')`, [callId, JSON.stringify(event)]));

const COLS = `caller_number, direction, call_status, call_started_at, duration_seconds, has_voicemail, quo_phone_number_id,
  summary, next_steps, transcript, transcript_dialogue, transcript_segments, voicemail_transcript, transcript_purged_at,
  customer_id, matched_customer_ids, match_status, last_webhook_id`;
const row = async (callId) => (await q(`select ${COLS} from public.call_transcripts where quo_call_id = $1`, [callId]))[0];
const snap = async (callId) => JSON.stringify(await row(callId));
const keys = (r) => (r.transcript_segments ?? []).map((s) => s.key);
const recs = (r) => (r.transcript_segments ?? []).map((s) => s.recording_id);
const contents = (r) => (r.transcript_dialogue ?? []).map((d) => d.content);

const realPrint = async () =>
  (
    await q(`select count(*)::int as n, md5(coalesce(string_agg(concat_ws('|', id, quo_call_id, md5(coalesce(transcript, '')),
        md5(coalesce(summary, '')), call_status, md5(coalesce(transcript_dialogue::text, '')),
        md5(coalesce(transcript_segments::text, '')), transcript_purged_at, last_webhook_id, updated_at), ',' order by id), '')) as fp
      from public.call_transcripts where quo_call_id not like 'ACprobe-%'`)
  )[0];

// --- events, in the shapes the app sends ---------------------------------------------
const CALLER = "+16145550142";
const base = { caller_number: CALLER, quo_phone_number_id: "PNXYakN6nP" };
const line = (speaker, content, start) => ({ speaker, content, start, end: start + 1, user_id: speaker === "staff" ? "USprobe" : null, has_identifier: true });
const L1 = [line("staff", "Crazy Larry's, go ahead", 0), line("caller", "Need a 20 yard Friday", 2)];
const L2 = [line("caller", "Back after the hold", 0), line("staff", "Friday works", 3)];
const text = (lines) => lines.map((l) => `${l.speaker === "staff" ? "Staff" : "Caller"}: ${l.content}`).join("\n");

const hookCompleted = (status = "answered") => ({ ...base, direction: "incoming", call_status: status, call_started_at: "2026-11-09T14:00:00Z", duration_seconds: 55, has_voicemail: false });
const hookSummary = (s = "Webhook summary") => ({ ...base, summary: s, next_steps: ["Webhook step"] });
const hookTranscript = (lines) => ({ ...base, transcript: text(lines), transcript_dialogue: lines });
const hookSegment = (lines, at) => ({ ...base, transcript_segment: { lines, order_at: at, duration: 30 } });
const restCall = (over = {}) => ({
  ...base, direction: "incoming", call_status: "completed", call_started_at: "2026-11-09T14:00:00Z", duration_seconds: 56,
  has_voicemail: false, summary: "REST summary", next_steps: ["REST step"], ...over,
});
const restSet = (...segs) => segs.map(([lines, at, rec]) => ({ lines, order_at: at, recording_id: rec, duration: 30 }));

await c.connect();
const before = await realPrint();
console.log(`real call_transcripts rows before: ${before.n}`);

try {
  await c.query("begin");
  const live = (await q(`select to_regprocedure('public.ingest_quo_call_event(text,text,jsonb,text)') is not null as b,
      exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'call_transcripts'
              and column_name = 'transcript_purged_at') as a`))[0];
  if (!live.a || !live.b) throw new Error("migrations 20261110000000 and 20261110010000 must be applied first");
  console.log("-- live functions (both migrations applied)");

  console.log("-- backfill after webhook");
  await webhook(id("bw"), hookCompleted());
  await webhook(id("bw"), hookSummary());
  await webhook(id("bw"), hookTranscript(L1));
  const w0 = await row(id("bw"));
  ok("webhook (segments off) stored a stage-1 transcript, no segments", w0.transcript === text(L1) && w0.transcript_segments === null);
  await backfill(id("bw"), restCall({ duration_seconds: 99, voicemail_transcript: "REST voicemail", transcript_segments: restSet([L1, "2026-11-09T14:00:01Z", "CR1"], [L2, "2026-11-09T14:03:00Z", "CR2"]) }));
  let r = await row(id("bw"));
  ok("webhook values kept: status, summary, next steps, duration, delivery id",
    r.call_status === "answered" && r.summary === "Webhook summary" && r.next_steps[0] === "Webhook step" && r.duration_seconds === 55 && r.last_webhook_id === "msg_probe");
  ok("empty field filled by the backfill (voicemail)", r.voicemail_transcript === "REST voicemail");
  ok("REST set replaced the segments: both recordings, in order", JSON.stringify(recs(r)) === JSON.stringify(["CR1", "CR2"]));
  ok("merged transcript: the first stretch, a divider, the second",
    JSON.stringify(contents(r)) === JSON.stringify([...L1.map((l) => l.content), "Call resumed", ...L2.map((l) => l.content)]) &&
      r.transcript_dialogue[2].speaker === "divider");
  const bwSnap = await snap(id("bw"));
  await backfill(id("bw"), restCall({ duration_seconds: 99, voicemail_transcript: "REST voicemail", transcript_segments: restSet([L1, "2026-11-09T14:00:01Z", "CR1"], [L2, "2026-11-09T14:03:00Z", "CR2"]) }));
  ok("the same backfill again (next day's run): nothing changes", (await snap(id("bw"))) === bwSnap);

  console.log("-- webhook after backfill");
  await backfill(id("wb"), restCall({ transcript_segments: restSet([L1, "2026-11-09T14:00:01Z", "CR1"]) }));
  r = await row(id("wb"));
  ok("backfill alone: row with REST values and one REST segment", r.call_status === "completed" && r.summary === "REST summary" && JSON.stringify(recs(r)) === '["CR1"]');
  const segBefore = JSON.stringify(r.transcript_segments);
  await webhook(id("wb"), hookCompleted("answered"));
  await webhook(id("wb"), hookSummary("Late webhook summary"));
  r = await row(id("wb"));
  ok("a late webhook delivery still updates its own fields (webhook rule: newer event wins)", r.call_status === "answered" && r.summary === "Late webhook summary");
  await webhook(id("wb"), hookTranscript(L1));
  await webhook(id("wb"), hookSegment(L1, "2026-11-09T14:01:30Z"));
  r = await row(id("wb"));
  ok("the same stretch from the webhook (stage-1 shape, then segment): same key, segments untouched, REST copy kept",
    JSON.stringify(r.transcript_segments) === segBefore && r.transcript === text(L1));
  const wbSnap = await snap(id("wb"));
  await backfill(id("wb"), restCall({ transcript_segments: restSet([L1, "2026-11-09T14:00:01Z", "CR1"]) }));
  ok("the next backfill changes nothing", (await snap(id("wb"))) === wbSnap);

  console.log("-- purged row");
  await q(`insert into public.call_transcripts (quo_call_id, call_started_at, received_at, call_status, transcript, transcript_dialogue)
           values ($1, now() - interval '200 days', now() - interval '200 days', 'answered', 'Staff: old', '[{"speaker":"staff","content":"old","start":0}]')`, [id("purged")]);
  const purged = await svc(async () => (await q(`select public.purge_call_transcripts(180) as n`))[0].n);
  ok("purge(180) took the old fixture", purged >= 1 && (await row(id("purged"))).transcript_purged_at !== null, purged);
  await backfill(id("purged"), restCall({ voicemail_transcript: "REST voicemail", transcript_segments: restSet([L1, "2026-05-01T14:00:01Z", "CR9"]) }));
  r = await row(id("purged"));
  ok("backfill on a purged row: no transcript, dialogue, segments or voicemail written",
    r.transcript === null && r.transcript_dialogue === null && r.transcript_segments === null && r.voicemail_transcript === null);
  ok("backfill on a purged row: its own empty fields still fill, existing ones kept", r.summary === "REST summary" && r.call_status === "answered");

  console.log("-- the same call through each path stores the same fields");
  const scalar = ["caller_number", "direction", "call_status", "call_started_at", "duration_seconds", "has_voicemail", "quo_phone_number_id",
    "summary", "next_steps", "transcript", "transcript_dialogue", "voicemail_transcript", "customer_id", "match_status"];
  const same = { ...base, direction: "incoming", call_status: "completed", call_started_at: "2026-11-09T14:00:00Z", duration_seconds: 56, has_voicemail: false, summary: "Same summary", next_steps: ["Same step"] };
  await webhook(id("viaHook"), { ...base, direction: same.direction, call_status: same.call_status, call_started_at: same.call_started_at, duration_seconds: same.duration_seconds, has_voicemail: false });
  await webhook(id("viaHook"), { ...base, summary: same.summary, next_steps: same.next_steps });
  await webhook(id("viaHook"), hookTranscript(L1));
  await webhook(id("viaSeg"), { ...base, direction: same.direction, call_status: same.call_status, call_started_at: same.call_started_at, duration_seconds: same.duration_seconds, has_voicemail: false });
  await webhook(id("viaSeg"), { ...base, summary: same.summary, next_steps: same.next_steps });
  await webhook(id("viaSeg"), hookSegment(L1, "2026-11-09T14:01:30Z"));
  await backfill(id("viaRest"), { ...same, transcript_segments: restSet([L1, "2026-11-09T14:00:01Z", "CR1"]) });
  const [h, s, b] = [await row(id("viaHook")), await row(id("viaSeg")), await row(id("viaRest"))];
  const diff = (x, y) => scalar.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  ok("webhook (segments off) vs backfill: every stored field equal", diff(h, b).length === 0, diff(h, b));
  ok("webhook (segments on) vs backfill: every stored field equal", diff(s, b).length === 0, diff(s, b));
  ok("webhook (segments on) vs backfill: same segment key; only recording id / order differ",
    JSON.stringify(keys(s)) === JSON.stringify(keys(b)) && s.transcript_segments[0].recording_id === null && b.transcript_segments[0].recording_id === "CR1");

  const inside = await realPrint();
  ok("real rows unchanged inside the transaction", inside.n === before.n && inside.fp === before.fp, { before: before.n, inside: inside.n });
  const probeRows = (await q(`select count(*)::int as n from public.call_transcripts where quo_call_id like $1`, [`ACprobe-${TAG}-%`]))[0].n;
  console.log(`   probe rows inside the transaction: ${probeRows}`);
} finally {
  await c.query("rollback");
}

const after = await realPrint();
const leftovers = (await q(`select count(*)::int as n from public.call_transcripts where quo_call_id like 'ACprobe-%'`))[0].n;
const total = (await q(`select count(*)::int as n, count(transcript_segments)::int as seg, count(transcript_purged_at)::int as purged from public.call_transcripts`))[0];
console.log("-- after rollback");
ok("real rows identical after rollback", after.n === before.n && after.fp === before.fp, { before: before.n, after: after.n });
ok("no probe rows left", leftovers === 0, leftovers);
console.log(`   call_transcripts now: ${total.n} rows, ${total.seg} with segments, ${total.purged} purged`);
await c.end();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
