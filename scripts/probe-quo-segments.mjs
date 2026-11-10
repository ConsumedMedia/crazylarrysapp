// Rolled-back probe for supabase/migrations/20261110010000_quo_transcript_segments.sql.
//
//   node --use-system-ca scripts/probe-quo-segments.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration itself, the fixture rows (quo_call_id 'ACprobe-<tag>-…', no caller
// number, so no customer match) and every ingest and purge below.
//
// The real call stored on 2026-11-03 is also exercised, inside savepoints
// that are rolled back at once: it is wrapped as segment 0, a retry and an
// identical segment are no-ops, and a backfill can't overwrite it. A
// fingerprint of every real row is checked inside the transaction and again
// after the rollback. Prints counts, keys, md5s and pass/fail, never call
// text or phone numbers.
//
// Roles: service_role does the ingests and purges. authenticated with real
// staff and customer claims, and anon, must be refused EXECUTE on all five
// call-log functions.
//
// A second connection checks what happens to an ingest that starts while the
// migration holds its lock: it waits, then completes when the lock is released.
//
// PROBE_MIGRATION overrides the file (mutation runs only).
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = process.env.PROBE_MIGRATION || "supabase/migrations/20261110010000_quo_transcript_segments.sql";
const BUILT_FROM = {
  "public.ingest_quo_call_event(text,text,jsonb)": "19d19f88a55e6437196db5987952abe9",
  "public.purge_call_transcripts(integer)": "05aa455352aff555361da37aa3a8430d",
};
const FUNCS = [
  "public.ingest_quo_call_event(text,text,jsonb,text)",
  "public.purge_call_transcripts(integer)",
  "public._redact_card_numbers(text)",
  "public._quo_segment(jsonb,boolean)",
  "public._quo_merge_segments(jsonb)",
];
const SERVICE_ONLY_ACL = "{postgres=X/postgres,service_role=X/postgres}";
const TAG = crypto.randomUUID().slice(0, 8);
const id = (name) => `ACprobe-${TAG}-${name}`;
const CARD = "4111 1111 1111 1111";
const REDACTED = "[card number removed]";
const jsRedact = (t) => t.replace(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g, REDACTED);
const jsKey = (contents) => "seg_" + crypto.createHash("md5").update(contents.map(jsRedact).join("\n"), "utf8").digest("hex");

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

async function attempt(fn) {
  await c.query("savepoint probe_attempt");
  try {
    const value = await fn();
    await c.query("release savepoint probe_attempt");
    return { ok: true, value };
  } catch (e) {
    await c.query("rollback to savepoint probe_attempt");
    return { ok: false, code: e.code, message: e.message };
  }
}
async function undone(fn) {
  await c.query("savepoint probe_undo");
  try {
    return await fn();
  } finally {
    await c.query("rollback to savepoint probe_undo");
  }
}
async function asRole(role, claims, fn) {
  await c.query(`set local role ${role}`);
  await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
    JSON.stringify(claims),
    claims.sub ?? "",
  ]);
  try {
    return await fn();
  } finally {
    await c.query("reset role");
    await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  }
}
const svc = (fn) => asRole("service_role", { role: "service_role" }, fn);
const authed = (sub, fn) => asRole("authenticated", { sub, role: "authenticated" }, fn);
const anon = (fn) => asRole("anon", { role: "anon" }, fn);
const refused = (r) => !r.ok && r.code === "42501";

/** ingest as service_role; source undefined = the 3-argument call the webhook route makes. */
const ingest = (callId, event, source) =>
  svc(() =>
    attempt(async () =>
      source === undefined
        ? (await q(`select public.ingest_quo_call_event(p_call_id => $1, p_webhook_id => 'probe-wh', p_event => $2::jsonb) as id`, [callId, JSON.stringify(event)]))[0].id
        : (await q(`select public.ingest_quo_call_event($1, $2, $3::jsonb, $4) as id`, [callId, source === "webhook" ? "probe-wh" : "probe-backfill", JSON.stringify(event), source]))[0].id,
    ),
  );
const row = async (callId) =>
  (
    await q(
      `select caller_number, direction, call_status, call_started_at, duration_seconds, has_voicemail, summary, next_steps,
              transcript, transcript_dialogue, transcript_segments, voicemail_transcript, transcript_purged_at,
              last_webhook_id, customer_id, match_status
         from public.call_transcripts where quo_call_id = $1`,
      [callId],
    )
  )[0];
/** Everything but updated_at, for "nothing changed" checks. */
const snapshot = async (callId) => JSON.stringify(await row(callId));
const contents = (dialogue) => (dialogue ?? []).map((d) => d.content);
const speakers = (dialogue) => (dialogue ?? []).map((d) => d.speaker);
const keys = (r) => (r.transcript_segments ?? []).map((s) => s.key);
const L = (speaker, content, start = 0) => ({ speaker, content, start, end: start + 1, user_id: speaker === "staff" ? "USprobe" : null, has_identifier: speaker !== "unknown" });
const seg = (lines, order_at, extra = {}) => ({ transcript_segment: { lines, order_at, ...extra } });

const realPrint = async () =>
  (
    await q(`select count(*)::int as n,
                    md5(coalesce(string_agg(concat_ws('|', id, quo_call_id, caller_number, customer_id, duration_seconds,
                        md5(coalesce(transcript, '')), md5(coalesce(summary, '')), received_at, direction, call_status,
                        call_started_at, has_voicemail, md5(coalesce(transcript_dialogue::text, '')),
                        md5(coalesce(voicemail_transcript, '')), transcript_purged_at, last_webhook_id, updated_at), ',' order by id), '')) as fp
               from public.call_transcripts where quo_call_id not like 'ACprobe-%'`)
  )[0];
const defInfo = async (sig) =>
  (
    await q(
      `select md5(pg_get_functiondef(p.oid)) as md5, p.proacl::text as acl, p.prosecdef as definer, p.proconfig::text as config,
              pg_get_userbyid(p.proowner) as owner,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [sig],
    )
  )[0];

await c.connect();
const before = await realPrint();
console.log(`real call_transcripts rows before: ${before.n}`);
let waiter = null;

try {
  await c.query("begin");
  const applied = (await q(`select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_segments'`))[0].n === 1;
  if (applied) console.log("-- migration already applied: probing the live definitions");
  else {
    console.log("-- live definitions the migration was built from");
    for (const [sig, md5] of Object.entries(BUILT_FROM)) {
      const d = await defInfo(sig);
      ok(`${sig.split("(")[0].replace("public.", "")}: live md5 and ACL unchanged since the migration was written`,
        d?.md5 === md5 && d?.acl === SERVICE_ONLY_ACL, d && { md5: d.md5, acl: d.acl });
    }
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    console.log("-- migration applied inside the transaction");
  }

  console.log("-- shape and grants");
  ok("the 3-argument ingest is gone (a 3-argument call can't be ambiguous)",
    (await q(`select to_regprocedure('public.ingest_quo_call_event(text,text,jsonb)') is null as gone`))[0].gone);
  ok("exactly one ingest_quo_call_event", (await q(`select count(*)::int as n from pg_proc where proname = 'ingest_quo_call_event' and pronamespace = 'public'::regnamespace`))[0].n === 1);
  for (const sig of FUNCS) {
    const d = await defInfo(sig);
    const name = sig.split("(")[0].replace("public.", "");
    ok(`${name}: INVOKER, search_path=public, owner postgres`, d && !d.definer && d.config === "{search_path=public}" && d.owner === "postgres",
      d && { definer: d.definer, config: d.config });
    ok(`${name}: ACL service_role only`, d && d.acl === SERVICE_ONLY_ACL && d.svc && !d.auth && !d.anon, d && d.acl);
    if (d) console.log(`      md5 ${d.md5}`);
  }
  const col = (await q(`select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_segments'`))[0];
  ok("transcript_segments: nullable jsonb", col?.data_type === "jsonb" && col?.is_nullable === "YES", col);

  console.log("-- redaction and keys match the app");
  const fixed = [
    `card ${CARD} end`, "4111-1111-1111-1111", "378282246310005", "6011000990139424 and 4111111111111111",
    "call 614-555-0142", "+16145550142", "12/29", "zip 43215", "$1,250.00", "1234567890123", "123456789012",
    "12345678901234567890", "x4111111111111111", "4111 1111 1111 1111-", "a 4111  1111 1111 1111 b", "unit 20-0042",
  ];
  const rand = Array.from({ length: 1500 }, (_, i) => {
    const alphabet = "0123456789 -a";
    let s = "";
    const n = 5 + (i % 40);
    for (let k = 0; k < n; k++) s += alphabet[crypto.randomInt(alphabet.length)];
    return s;
  });
  const all = [...fixed, ...rand];
  const dbRedacted = await svc(async () => (await q(`select public._redact_card_numbers(x) as r from unnest($1::text[]) with ordinality as u(x, n) order by n`, [all])).map((r) => r.r));
  const mismatches = all.filter((s, i) => dbRedacted[i] !== jsRedact(s));
  ok(`database redaction equals lib/call-log/redact.ts on ${all.length} strings`, mismatches.length === 0, mismatches.slice(0, 3).map((s) => s.length));
  const keyLines = [L("staff", "Crazy Larry's"), L("caller", `It's ${CARD}`, 2)];
  const dbSeg = await svc(async () => (await q(`select public._quo_segment($1::jsonb, false) as s`, [JSON.stringify({ lines: keyLines })]))[0].s);
  ok("segment key equals lib/call-log/segments.ts segmentKey", dbSeg.key === jsKey(keyLines.map((l) => l.content)), dbSeg.key);
  ok("stored segment lines are redacted", !JSON.stringify(dbSeg).includes("4111"));
  const rawMerge = await svc(async () =>
    (await q(`select public._quo_merge_segments($1::jsonb) as m`, [
      JSON.stringify([{ key: "seg_raw", order_at: null, wrapped: false, lines: [{ speaker: "caller", content: `raw ${CARD}` }] }]),
    ]))[0].m,
  );
  ok("merge redacts even a segment that skipped _quo_segment (dialogue and text)",
    !JSON.stringify(rawMerge.dialogue).includes("4111") && rawMerge.transcript === `Caller: raw ${REDACTED}`);

  console.log("-- out-of-order segments merge in call order (webhook)");
  const A = [L("staff", "Part one, staff"), L("caller", `Part one, caller ${CARD}`, 2)];
  const B = [L("caller", "Part two, caller"), L("staff", "Part two, staff", 1)];
  const Cl = [L("caller", "Part three")];
  await ingest(id("seg"), seg(B, "2026-11-09T14:05:00Z"));
  await ingest(id("seg"), seg(Cl, "2026-11-09T14:09:00Z"));
  const first = await ingest(id("seg"), seg(A, "2026-11-09T14:00:00Z"));
  ok("3-argument named call (the webhook route's) works", first.ok, first.ok ? undefined : { code: first.code });
  let r = await row(id("seg"));
  ok("dialogue in call order with a divider between each segment",
    JSON.stringify(contents(r.transcript_dialogue)) ===
      JSON.stringify(["Part one, staff", `Part one, caller ${REDACTED}`, "Call resumed", "Part two, caller", "Part two, staff", "Call resumed", "Part three"]),
    contents(r.transcript_dialogue).length);
  const dividers = r.transcript_dialogue.filter((d) => d.speaker === "divider");
  ok("dividers: speaker 'divider', no user id, no identifier, no times",
    dividers.length === 2 && dividers.every((d) => d.user_id === null && d.has_identifier === false && d.start === null && d.end === null));
  ok("no divider carries a staff/caller label", r.transcript_dialogue.every((d) => d.content !== "Call resumed" || d.speaker === "divider"));
  ok("plain text: divider line has no speaker prefix; lines in order",
    r.transcript === ["Staff: Part one, staff", `Caller: Part one, caller ${REDACTED}`, "— Call resumed —", "Caller: Part two, caller", "Staff: Part two, staff", "— Call resumed —", "Caller: Part three"].join("\n"));
  ok("merged text and stored segments are redacted", !/4111/.test(r.transcript + JSON.stringify(r.transcript_dialogue) + JSON.stringify(r.transcript_segments)));
  ok("segments stored sorted by order_at", JSON.stringify(keys(r)) === JSON.stringify([jsKey(contents(A)), jsKey(contents(B)), jsKey(contents(Cl))]));

  console.log("-- a retry is a no-op");
  const snap = await snapshot(id("seg"));
  await ingest(id("seg"), seg(B, "2026-11-09T14:05:00Z"));
  ok("same segment again: row unchanged", (await snapshot(id("seg"))) === snap);
  await ingest(id("seg"), seg(B, "2026-11-09T14:30:00Z", { recording_id: "CRother" }));
  ok("same text with other timing (e.g. from REST): row unchanged, kept the stored copy", (await snapshot(id("seg"))) === snap);
  await ingest(id("seg"), seg(B, "2026-11-09T13:00:00Z", { recording_id: "CRearlier" }));
  ok("same text with an EARLIER time: still the stored copy (not re-sorted, no duplicate)", (await snapshot(id("seg"))) === snap);

  console.log("-- forged and empty input");
  await ingest(id("forge"), seg([L("divider", "Call resumed"), L("caller", "  ")], "2026-11-09T14:00:00Z"));
  r = await row(id("forge"));
  ok("a 'divider' speaker sent in is stored as unknown; empty lines dropped",
    JSON.stringify(speakers(r.transcript_dialogue)) === JSON.stringify(["unknown"]) && r.transcript === "Unknown: Call resumed" &&
      r.transcript_segments[0].lines[0].speaker === "unknown");
  const emptySeg = await ingest(id("forge"), seg([L("caller", " ")], "2026-11-09T15:00:00Z"));
  ok("a segment with no text adds nothing", emptySeg.ok && keys(await row(id("forge"))).length === 1);
  for (const bad of [null, "cron", ""]) {
    const res = await svc(() => attempt(() => q(`select public.ingest_quo_call_event('x', 'w', '{}'::jsonb, $1)`, [bad])));
    ok(`p_source ${JSON.stringify(bad)} refused 22023`, !res.ok && res.code === "22023", res.ok ? res : { code: res.code });
  }

  console.log("-- stage-1 rows: unchanged until a segment arrives, then wrapped as segment 0");
  const oldDialogue = [{ speaker: "staff", content: "Old one", start: 0 }, { speaker: "caller", content: "Old two", start: 4 }];
  await ingest(id("old"), { transcript: "Staff: Old one\nCaller: Old two", transcript_dialogue: oldDialogue });
  r = await row(id("old"));
  ok("stage-1 event: no segments, text as sent", r.transcript_segments === null && r.transcript === "Staff: Old one\nCaller: Old two");
  await ingest(id("old"), { transcript: "Staff: Replaced", transcript_dialogue: [{ speaker: "staff", content: "Replaced", start: 0 }] });
  ok("stage-1 event on a stage-1 row: last wins, as before", (await row(id("old"))).transcript === "Staff: Replaced");
  await ingest(id("old"), { transcript: "Staff: Old one\nCaller: Old two", transcript_dialogue: oldDialogue });
  await ingest(id("old"), seg([L("caller", "After the pause")], "2026-11-09T14:10:00Z"));
  r = await row(id("old"));
  ok("first segment wraps the old dialogue as segment 0 (wrapped:true), then adds itself",
    r.transcript_segments.length === 2 && r.transcript_segments[0].wrapped === true && r.transcript_segments[1].wrapped === false &&
      JSON.stringify(contents(r.transcript_dialogue)) === JSON.stringify(["Old one", "Old two", "Call resumed", "After the pause"]));
  ok("wrapped lines keep speaker and start", JSON.stringify(r.transcript_segments[0].lines.map((l) => [l.speaker, l.start])) === JSON.stringify([["staff", 0], ["caller", 4]]));
  await ingest(id("old2"), { transcript: "Staff: Old one\nCaller: Old two", transcript_dialogue: oldDialogue });
  await ingest(id("old2"), seg([L("staff", "Old one"), L("caller", "Old two", 4)], "2026-11-09T14:00:00Z"));
  r = await row(id("old2"));
  ok("a segment with the same text as the stage-1 transcript is the same key: one segment, no divider",
    r.transcript_segments.length === 1 && !speakers(r.transcript_dialogue).includes("divider") && r.transcript === "Staff: Old one\nCaller: Old two");
  await ingest(id("old"), { transcript: "Staff: Late stage-1", transcript_dialogue: [{ speaker: "staff", content: "Late stage-1", start: 0 }] });
  r = await row(id("old"));
  ok("a stage-1 event on a row with segments joins as a segment instead of replacing",
    r.transcript_segments.length === 3 && contents(r.transcript_dialogue).includes("Late stage-1") && contents(r.transcript_dialogue).includes("Old one"));

  console.log("-- REST replaces the set (backfill only)");
  const restSet = [
    { lines: B, order_at: "2026-11-09T14:05:00Z", recording_id: "CR2", duration: 30 },
    { lines: [L("caller", "Only REST has this")], order_at: "2026-11-09T14:20:00Z", recording_id: "CR4" },
  ];
  const webhookTry = await ingest(id("seg"), { transcript_segments: restSet }, "webhook");
  ok("a set sent with source webhook is ignored", webhookTry.ok && (await snapshot(id("seg"))) === snap);
  await ingest(id("seg"), { transcript_segments: restSet }, "backfill");
  r = await row(id("seg"));
  ok("backfill set replaces the segments exactly", JSON.stringify(keys(r)) === JSON.stringify([jsKey(contents(B)), jsKey(["Only REST has this"])]),
    keys(r).length);
  ok("merged text follows the new set", r.transcript === "Caller: Part two, caller\nStaff: Part two, staff\n— Call resumed —\nCaller: Only REST has this");
  ok("REST metadata kept (recording id, duration)", r.transcript_segments[0].recording_id === "CR2" && Number(r.transcript_segments[0].duration) === 30);
  const snap2 = await snapshot(id("seg"));
  await ingest(id("seg"), { transcript_segments: [{ lines: [] }, { nope: 1 }] }, "backfill");
  ok("a set with no usable segment changes nothing", (await snapshot(id("seg"))) === snap2);

  console.log("-- backfill never overwrites webhook values");
  const hook = {
    caller_number: "+15550100000".replace(/0000$/, "9999"),
    direction: "incoming", call_status: "answered", call_started_at: "2026-11-09T14:00:00Z", duration_seconds: 55,
    has_voicemail: false, quo_phone_number_id: "PNXYakN6nP", summary: "Webhook summary", next_steps: ["Webhook step"],
    voicemail_transcript: "Webhook voicemail", transcript: "Staff: Webhook", transcript_dialogue: [{ speaker: "staff", content: "Webhook", start: 0 }],
  };
  await ingest(id("fill"), hook);
  const fillSnap = await snapshot(id("fill"));
  await ingest(id("fill"), {
    caller_number: "+16145550000", direction: "outgoing", call_status: "missed", call_started_at: "2026-11-01T00:00:00Z", duration_seconds: 1,
    has_voicemail: true, quo_phone_number_id: "PNother", summary: "Backfill summary", next_steps: ["Backfill step"],
    voicemail_transcript: "Backfill voicemail", transcript: "Staff: Backfill", transcript_dialogue: [{ speaker: "staff", content: "Backfill", start: 0 }],
  }, "backfill");
  ok("every webhook value survives a backfill with different values", (await snapshot(id("fill"))) === fillSnap);
  await ingest(id("fill2"), { call_status: "answered" });
  await ingest(id("fill2"), { call_status: "missed", summary: "Filled by backfill", duration_seconds: 40 }, "backfill");
  r = await row(id("fill2"));
  ok("backfill fills only the empty fields", r.call_status === "answered" && r.summary === "Filled by backfill" && r.duration_seconds === 40);
  ok("backfill keeps the webhook's delivery id", r.last_webhook_id === "probe-wh");
  await ingest(id("bfnew"), { call_status: "completed", summary: "New from backfill" }, "backfill");
  ok("a call the webhook never sent is inserted by backfill", (await row(id("bfnew")))?.summary === "New from backfill");

  console.log("-- purged rows stay purged");
  await q(`insert into public.call_transcripts (quo_call_id, call_started_at, received_at, summary) values ($1, now() - interval '200 days', now() - interval '200 days', 'kept')`, [id("purged")]);
  await ingest(id("purged"), seg(A, "2026-05-01T14:00:00Z"));
  ok("an old row with segments", (await row(id("purged"))).transcript_segments?.length === 1);
  const pr = await svc(() => attempt(async () => (await q(`select public.purge_call_transcripts(180) as n`))[0].n));
  ok("purge(180) takes it (segments count as text)", pr.ok && pr.value === 1, pr.value);
  r = await row(id("purged"));
  ok("purge blanks segments too; summary kept", r.transcript_segments === null && r.transcript === null && r.transcript_dialogue === null && r.summary === "kept" && r.transcript_purged_at !== null);
  const purgedSnap = await snapshot(id("purged"));
  await ingest(id("purged"), seg(B, "2026-05-01T14:05:00Z"));
  await ingest(id("purged"), { transcript_segments: restSet }, "backfill");
  await ingest(id("purged"), { transcript: "Staff: again", transcript_dialogue: [{ speaker: "staff", content: "again", start: 0 }], voicemail_transcript: "vm" });
  await ingest(id("purged"), { transcript: "Staff: again", voicemail_transcript: "vm" }, "backfill");
  ok("webhook segment, backfill set, stage-1 transcript and backfill text all leave it purged", (await snapshot(id("purged"))) === purgedSnap);

  console.log("-- the real call from 2026-11-03 (savepoints, rolled back at once)");
  const realId = (await q(`select quo_call_id from public.call_transcripts where quo_call_id not like 'ACprobe-%' order by received_at limit 1`))[0]?.quo_call_id;
  if (!realId) ok("real row present", false);
  else {
    const real = await row(realId);
    const realLines = contents(real.transcript_dialogue);
    console.log(`   real row: ${String(realId).slice(0, 6)}…, ${realLines.length} lines, segments=${real.transcript_segments === null ? "none" : "some"}, purged=${real.transcript_purged_at !== null}`);
    await undone(async () => {
      const res = await ingest(realId, seg([L("caller", "Probe: after the pause")], "2099-01-01T00:00:00Z"));
      const x = await row(realId);
      ok("real: a new segment wraps the stored dialogue as segment 0 and appends after a divider",
        res.ok && x.transcript_segments.length === 2 && x.transcript_segments[0].wrapped === true &&
          JSON.stringify(contents(x.transcript_dialogue)) === JSON.stringify([...realLines.map(jsRedact), "Call resumed", "Probe: after the pause"]));
      ok("real: wrapped segment keeps every stored line, speaker and start",
        JSON.stringify(x.transcript_segments[0].lines.map((l) => [l.speaker, l.start])) ===
          JSON.stringify(real.transcript_dialogue.map((l) => [["staff", "caller", "unknown"].includes(l.speaker) ? l.speaker : "unknown", l.start ?? null])));
      ok("real: summary, status, customer link untouched",
        x.summary === real.summary && x.call_status === real.call_status && x.customer_id === real.customer_id && x.match_status === real.match_status);
      const s1 = await snapshot(realId);
      await ingest(realId, seg([L("caller", "Probe: after the pause")], "2099-01-01T00:00:00Z"));
      ok("real: the same segment again is a no-op", (await snapshot(realId)) === s1);
    });
    await undone(async () => {
      await ingest(realId, seg(real.transcript_dialogue.map((l) => ({ ...l })), "2026-11-03T21:16:47Z"));
      const x = await row(realId);
      ok("real: a segment with the stored text is the same key: one segment, text unchanged",
        x.transcript_segments.length === 1 && JSON.stringify(contents(x.transcript_dialogue)) === JSON.stringify(realLines.map(jsRedact)) &&
          !speakers(x.transcript_dialogue).includes("divider"));
    });
    await undone(async () => {
      const s0 = await snapshot(realId);
      await ingest(realId, { summary: "Probe backfill summary", call_status: "missed", duration_seconds: 1, direction: "outgoing" }, "backfill");
      ok("real: a backfill with different values changes nothing", (await snapshot(realId)) === s0);
    });
    ok("real: back exactly as stored after the savepoints", JSON.stringify(await row(realId)) === JSON.stringify(real));
  }

  console.log("-- user sessions are refused");
  const staff = (await q(`select id from public.profiles where role in ('owner','staff') and removed_at is null and not is_protected order by created_at limit 1`))[0]?.id;
  const customer = (await q(`select id from public.profiles where role = 'customer' order by created_at limit 1`))[0]?.id;
  const calls = {
    ingest: () => q(`select public.ingest_quo_call_event($1, 'x', '{}'::jsonb)`, [id("user-try")]),
    "ingest(backfill)": () => q(`select public.ingest_quo_call_event($1, 'x', '{}'::jsonb, 'backfill')`, [id("user-try")]),
    purge: () => q(`select public.purge_call_transcripts(180)`),
    redact: () => q(`select public._redact_card_numbers('x')`),
    segment: () => q(`select public._quo_segment('{"lines":[]}'::jsonb, false)`),
    merge: () => q(`select public._quo_merge_segments('[]'::jsonb)`),
  };
  for (const [who, run] of [["staff", (fn) => authed(staff, fn)], ["customer", (fn) => authed(customer, fn)], ["anon", anon]]) {
    const results = {};
    for (const [name, call] of Object.entries(calls)) results[name] = await run(() => attempt(call));
    const bad = Object.entries(results).filter(([, x]) => !refused(x)).map(([n]) => n);
    ok(`${who}: all ${Object.keys(calls).length} calls refused 42501`, bad.length === 0, bad.length ? bad : undefined);
  }
  const staffRead = await authed(staff, () => attempt(async () => (await q(`select count(transcript_segments)::int as n from public.call_transcripts where quo_call_id like $1`, [`ACprobe-${TAG}-%`]))[0].n));
  ok("staff session reads transcript_segments through RLS", staffRead.ok && staffRead.value > 0, staffRead.value);
  const custRead = await authed(customer, () => attempt(async () => (await q(`select count(*)::int as n from public.call_transcripts`))[0].n));
  ok("customer session reads no call rows", custRead.ok && custRead.value === 0, custRead.value);

  const inside = await realPrint();
  ok("real rows unchanged inside the transaction", inside.n === before.n && inside.fp === before.fp, { before: before.n, inside: inside.n });

  if (!applied) {
    console.log("-- an ingest that starts while the migration holds its lock");
    const c2 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    const pid2 = (await c2.query(`select pg_backend_pid() as p`)).rows[0].p;
    await c2.query("begin");
    await c2.query("set local role service_role");
    await c2.query("set local lock_timeout = '20s'");
    const started = Date.now();
    waiter = {
      c2,
      started,
      done: c2
        .query(`select public.ingest_quo_call_event(p_call_id => $1, p_webhook_id => 'probe-wait', p_event => '{"call_status":"answered"}'::jsonb) as id`, [id("waiter")])
        .then((res) => ({ ok: true, id: res.rows[0].id }), (e) => ({ ok: false, code: e.code, message: e.message })),
    };
    let waiting = false;
    for (let i = 0; i < 40 && !waiting; i++) {
      await new Promise((res) => setTimeout(res, 100));
      waiting = (await q(`select count(*)::int as n from pg_locks where pid = $1 and not granted`, [pid2]))[0].n > 0;
    }
    ok("the second connection's ingest is waiting on the lock, not failing", waiting);
  }
} finally {
  await c.query("rollback");
}

if (waiter) {
  const res = await waiter.done;
  ok("once the lock is released, the waiting ingest completes (no error)", res.ok, res.ok ? { waitedMs: Date.now() - waiter.started } : { code: res.code });
  await waiter.c2.query("rollback");
  await waiter.c2.end();
}

const afterAll = await realPrint();
const leftovers = (await q(`select count(*)::int as n from public.call_transcripts where quo_call_id like 'ACprobe-%'`))[0].n;
const colAfter = (await q(`select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_segments'`))[0].n;
const oldSig = (await q(`select to_regprocedure('public.ingest_quo_call_event(text,text,jsonb)') is not null as e`))[0].e;
console.log("-- after rollback");
ok("real rows identical after rollback", afterAll.n === before.n && afterAll.fp === before.fp, { before: before.n, after: afterAll.n });
ok("no probe rows left (including the waiting connection's)", leftovers === 0, leftovers);
console.log(`   live state after rollback: transcript_segments present=${colAfter === 1}, 3-argument ingest present=${oldSig}`);
await c.end();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
