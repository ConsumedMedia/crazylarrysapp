// Rolled-back probe for supabase/migrations/20261110000000_call_transcript_purge.sql.
//
//   node --use-system-ca scripts/probe-quo-purge.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration itself, the fixture rows (quo_call_id 'ACprobe-<tag>-…', no caller
// number, so no customer match) and every purge and ingest below. Real
// call_transcripts rows are only read: a fingerprint of them is taken before
// and checked after, inside the transaction and again after the rollback.
// Prints counts, ids and pass/fail only, never call text or phone numbers.
//
// Roles: service_role (the cron's and the webhook's role) does the purges and
// ingests; authenticated with real staff and customer claims, and anon, must
// be refused EXECUTE on both functions.
//
// Safe to re-run after the migration is applied: it then skips applying it and
// probes the live definitions.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

// PROBE_MIGRATION overrides the file (mutation runs only: point it at a deliberately broken copy).
const MIGRATION = process.env.PROBE_MIGRATION || "supabase/migrations/20261110000000_call_transcript_purge.sql";
const TAG = crypto.randomUUID().slice(0, 8);
const id = (name) => `ACprobe-${TAG}-${name}`;
const PURGE = "public.purge_call_transcripts(integer)";
const INGEST = "public.ingest_quo_call_event(text,text,jsonb)";

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

const purge = (days) => attempt(async () => (await q(`select public.purge_call_transcripts($1) as n`, [days]))[0].n);
const ingest = (callId, event) =>
  attempt(async () => (await q(`select public.ingest_quo_call_event($1, 'probe', $2::jsonb) as id`, [callId, JSON.stringify(event)]))[0].id);
const refused = (r) => !r.ok && r.code === "42501";
const badArg = (r) => !r.ok && r.code === "22023";

// Real rows, by the columns that existed before this migration.
const realPrint = async () =>
  (
    await q(`select count(*)::int as n,
                    md5(coalesce(string_agg(concat_ws('|', id, quo_call_id, caller_number, customer_id, duration_seconds,
                        md5(coalesce(transcript, '')), md5(coalesce(summary, '')), received_at, direction, call_status,
                        call_started_at, has_voicemail, md5(coalesce(transcript_dialogue::text, '')),
                        md5(coalesce(voicemail_transcript, '')), updated_at), ',' order by id), '')) as fp
               from public.call_transcripts where quo_call_id not like 'ACprobe-%'`)
  )[0];
const row = async (callId) =>
  (
    await q(
      `select transcript, transcript_dialogue, voicemail_transcript, summary, next_steps, duration_seconds,
              transcript_purged_at, updated_at
         from public.call_transcripts where quo_call_id = $1`,
      [callId],
    )
  )[0];
const fnAttrs = async (sig) =>
  (
    await q(
      `select p.prosecdef as definer, p.proconfig::text as config, pg_get_userbyid(p.proowner) as owner,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
              p.proacl::text as acl, p.prosrc as src
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [sig],
    )
  )[0];

await c.connect();
const before = await realPrint();
console.log(`real call_transcripts rows before: ${before.n}`);

try {
  await c.query("begin");
  const applied = (await q(`select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_purged_at'`))[0].n === 1;
  if (applied) console.log("-- migration already applied: probing the live definitions");
  else {
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    console.log("-- migration applied inside the transaction");
  }

  console.log("-- shape and grants");
  for (const sig of [PURGE, INGEST]) {
    const a = await fnAttrs(sig);
    ok(`${sig.split("(")[0].replace("public.", "")}: INVOKER, search_path=public, owner postgres`,
      a && !a.definer && a.config === "{search_path=public}" && a.owner === "postgres", a && { definer: a.definer, config: a.config, owner: a.owner });
    ok(`${sig.split("(")[0].replace("public.", "")}: EXECUTE service_role only (not anon, not authenticated)`,
      a && a.svc && !a.auth && !a.anon, a && { anon: a.anon, auth: a.auth, svc: a.svc, acl: a.acl });
  }
  const ing = await fnAttrs(INGEST);
  ok("ingest keeps purged transcript fields empty (3 guards in the definition)",
    (ing.src.match(/when t\.transcript_purged_at is not null then null/g) ?? []).length === 3);
  const col = (await q(`select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_purged_at'`))[0];
  ok("transcript_purged_at: nullable timestamptz", col?.data_type === "timestamp with time zone" && col?.is_nullable === "YES", col);
  const colPriv = (await q(`select has_column_privilege('authenticated', 'public.call_transcripts', 'transcript_purged_at', 'SELECT') as auth,
      has_column_privilege('service_role', 'public.call_transcripts', 'transcript_purged_at', 'UPDATE') as svc`))[0];
  ok("staff (authenticated + RLS) can read the column; service_role can write it", colPriv.auth && colPriv.svc, colPriv);

  console.log("-- fixtures (inside the transaction)");
  const text = { transcript: "Staff: probe line", transcript_dialogue: [{ speaker: "staff", content: "probe line", start: 0 }], voicemail_transcript: "probe voicemail" };
  const fixtures = [
    ["old", "200 days", text],
    ["edge181", "181 days", text],
    ["edge179", "179 days", text],
    ["recent", "1 day", text],
    ["notext", "200 days", {}],
  ];
  for (const [name, age, t] of fixtures) {
    await q(
      `insert into public.call_transcripts (quo_call_id, call_started_at, received_at, summary, next_steps,
                                            transcript, transcript_dialogue, voicemail_transcript, duration_seconds)
       values ($1, now() - $2::interval, now() - $2::interval, 'probe summary', array['probe step'], $3, $4::jsonb, $5, 60)`,
      [id(name), age, t.transcript ?? null, t.transcript_dialogue ? JSON.stringify(t.transcript_dialogue) : null, t.voicemail_transcript ?? null],
    );
  }
  // No call start time: age falls back to received_at.
  await q(`insert into public.call_transcripts (quo_call_id, received_at, transcript) values ($1, now() - interval '200 days', 'Staff: no start')`, [id("nostart")]);
  // Age counts from the CALL, not from when the row arrived: an old call stored
  // yesterday (backfilled) is purged; a recent call on an old row is not.
  await q(`insert into public.call_transcripts (quo_call_id, call_started_at, received_at, transcript)
           values ($1, now() - interval '200 days', now() - interval '1 day', 'Staff: backfilled')`, [id("backfilled")]);
  await q(`insert into public.call_transcripts (quo_call_id, call_started_at, received_at, transcript)
           values ($1, now() - interval '10 days', now() - interval '200 days', 'Staff: late start')`, [id("latestart")]);
  console.log(`   ${fixtures.length + 3} fixture rows`);

  console.log("-- purge refuses short or missing retention (service_role)");
  for (const days of [null, -5, 0, 29]) {
    const r = await svc(() => purge(days));
    ok(`purge(${days}) refused 22023`, badArg(r), r.ok ? r : { code: r.code });
  }
  ok("refusal message names the 30-day floor", (await svc(() => purge(29))).message?.includes("at least 30 days"));

  console.log("-- purge(180) as service_role");
  const r180 = await svc(() => purge(180));
  ok("purge(180) runs", r180.ok, r180.ok ? undefined : { code: r180.code });
  const probePurged = (await q(`select count(*)::int as n from public.call_transcripts where quo_call_id like $1 and transcript_purged_at is not null`, [`ACprobe-${TAG}-%`]))[0].n;
  ok("exactly the four old calls with text were purged (old, edge181, nostart, backfilled)", probePurged === 4 && r180.value === 4, { probePurged, returned: r180.value });
  ok("a recent call on an old row is not purged (age is from the call)", (await row(id("latestart"))).transcript_purged_at === null);
  for (const name of ["old", "edge181", "nostart"]) {
    const x = await row(id(name));
    ok(`${name}: text gone, summary + next steps + duration kept, purged_at set`,
      x.transcript === null && x.transcript_dialogue === null && x.voicemail_transcript === null &&
        (name === "nostart" || (x.summary === "probe summary" && x.next_steps?.[0] === "probe step" && x.duration_seconds === 60)) &&
        x.transcript_purged_at !== null);
  }
  for (const name of ["edge179", "recent"]) {
    const x = await row(id(name));
    ok(`${name}: untouched`, x.transcript === "Staff: probe line" && x.voicemail_transcript === "probe voicemail" && x.transcript_purged_at === null);
  }
  ok("notext: not stamped (nothing to remove)", (await row(id("notext"))).transcript_purged_at === null);
  const again = await svc(() => purge(180));
  ok("second purge(180) the same day removes nothing", again.ok && again.value === 0, again.value);

  await undone(async () => {
    const r30 = await svc(() => purge(30));
    ok("purge(30) also takes edge179 (only rows still holding text)", r30.ok && r30.value === 1, r30.value);
    ok("purge(30) leaves the 1-day-old row", (await row(id("recent"))).transcript !== null);
  });

  console.log("-- ingest after purge (service_role): never refills");
  const stampedAt = (await row(id("old"))).transcript_purged_at;
  const after = await svc(() =>
    ingest(id("old"), {
      transcript: "Staff: late retry",
      transcript_dialogue: [{ speaker: "staff", content: "late retry", start: 0 }],
      voicemail_transcript: "late voicemail",
      summary: "newer summary",
      duration_seconds: 61,
    }),
  );
  ok("ingest on a purged row succeeds", after.ok, after.ok ? undefined : { code: after.code });
  const o = await row(id("old"));
  ok("purged row: transcript, dialogue, voicemail stay empty", o.transcript === null && o.transcript_dialogue === null && o.voicemail_transcript === null);
  ok("purged row: other fields still update; purged_at unchanged",
    o.summary === "newer summary" && o.duration_seconds === 61 && String(o.transcript_purged_at) === String(stampedAt));

  console.log("-- ingest unchanged for rows not purged");
  const live = await svc(() => ingest(id("edge179"), { transcript: "Staff: replaced" }));
  ok("unpurged row: a new transcript replaces the old (stage-1 behavior)", live.ok && (await row(id("edge179"))).transcript === "Staff: replaced");
  await svc(() => ingest(id("edge179"), { summary: "s2" }));
  ok("unpurged row: an event without transcript keeps it", (await row(id("edge179"))).transcript === "Staff: replaced");
  const fresh = await svc(() => ingest(id("new"), { call_status: "answered", transcript: "Staff: fresh" }));
  ok("a new call is inserted with its transcript and no purge stamp", fresh.ok && (await row(id("new"))).transcript === "Staff: fresh" && (await row(id("new"))).transcript_purged_at === null);

  console.log("-- user sessions are refused");
  const staff = (await q(`select id from public.profiles where role in ('owner','staff') and removed_at is null and not is_protected order by created_at limit 1`))[0]?.id;
  const customer = (await q(`select id from public.profiles where role = 'customer' order by created_at limit 1`))[0]?.id;
  ok("found a staff and a customer profile to act as", !!staff && !!customer, { staff: String(staff).slice(0, 8), customer: String(customer).slice(0, 8) });
  for (const [who, run] of [
    ["staff", (fn) => authed(staff, fn)],
    ["customer", (fn) => authed(customer, fn)],
    ["anon", anon],
  ]) {
    const p = await run(() => purge(180));
    ok(`${who}: purge refused 42501`, refused(p), p.ok ? p : { code: p.code });
    const i = await run(() => ingest(id(`${who}-try`), { transcript: "x" }));
    ok(`${who}: ingest refused 42501`, refused(i), i.ok ? i : { code: i.code });
  }
  const staffSees = await authed(staff, () =>
    attempt(async () => (await q(`select count(*)::int as n from public.call_transcripts where quo_call_id like $1 and transcript_purged_at is not null`, [`ACprobe-${TAG}-%`]))[0].n),
  );
  ok("staff session reads transcript_purged_at on the purged rows", staffSees.ok && staffSees.value === 4, staffSees.value);
  const custSees = await authed(customer, () =>
    attempt(async () => (await q(`select count(*)::int as n from public.call_transcripts`))[0].n),
  );
  ok("customer session reads no call rows", custSees.ok && custSees.value === 0, custSees.value);

  const inside = await realPrint();
  ok("real rows unchanged inside the transaction", inside.n === before.n && inside.fp === before.fp, { before: before.n, inside: inside.n });
} finally {
  await c.query("rollback");
}

const afterAll = await realPrint();
const leftovers = (await q(`select count(*)::int as n from public.call_transcripts where quo_call_id like 'ACprobe-%'`))[0].n;
const colAfter = (await q(`select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_purged_at'`))[0].n;
const fnAfter = (await q(`select to_regprocedure('public.purge_call_transcripts(integer)') is not null as e`))[0].e;
console.log("-- after rollback");
ok("real rows identical after rollback", afterAll.n === before.n && afterAll.fp === before.fp, { before: before.n, after: afterAll.n });
ok("no probe rows left", leftovers === 0, leftovers);
console.log(`   live state after rollback: column present=${colAfter === 1}, purge function present=${fnAfter}`);
await c.end();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
