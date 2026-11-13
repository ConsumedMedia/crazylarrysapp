// Rolled-back probe for supabase/migrations/20261113000000_sms_opt_outs.sql (Plan B.4).
//
//   node --use-system-ca scripts/probe-sms-opt-outs.mjs   (repo root; reads DATABASE_URL from .env.local)
//   PROBE_MIGRATION=<file> ...   probes another copy of the migration (mutation runs)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration, four probe customers on reserved 555-01xx numbers, and every call
// below. Real rows are only READ. Prints no real phone numbers or names.
//
// Safe to re-run after the migration is applied: the tables then already
// exist, the migration is not re-run, and the live definitions are probed.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = process.env.PROBE_MIGRATION || "supabase/migrations/20261113000000_sms_opt_outs.sql";
const LARRY = "923ed11f-196b-4939-9639-f576b4d88c87"; // owner (staff)
const NOBODY = crypto.randomUUID(); // signed in, no profile: not staff
const TAG = crypto.randomUUID().slice(0, 8);
const NEW_TABLES = ["sms_opt_outs", "sms_inbound_events"];
const NEW_FUNCTIONS = ["_sms_phone_key", "_apply_sms_opt_out", "record_sms_inbound", "sms_block_status", "resolve_sms_review", "purge_sms_review_text"];
const CHANGED_CONSTRAINTS = ["consent_records_source_check", "notifications_log_failure_category_check"];
const CONSENT_CHECK =
  "CHECK ((source = ANY (ARRAY['phone_verbal'::text, 'pay_page'::text, 'sms_reply'::text, 'staff_review'::text])))";
const FAILURE_CHECK =
  "CHECK (((failure_category IS NULL) OR (failure_category = ANY (ARRAY['disabled'::text, 'test_mode'::text, 'not_configured'::text, 'account_blocked'::text, 'provider_rejected'::text, 'rate_limited'::text, 'transient'::text, 'recipient_missing'::text, 'no_consent'::text, 'opted_out'::text]))))";

// The phone-key rule. lib/sms-inbound/phone-key.test.ts holds the same table.
const KEY_CASES = [
  ["6145550143", "6145550143"],
  ["614-555-0143", "6145550143"],
  ["(614) 555-0143", "6145550143"],
  ["+1 (614) 555-0143", "6145550143"],
  ["+16145550143", "6145550143"],
  ["16145550143", "6145550143"],
  ["614.555.0143", "6145550143"],
  [" 614 555 0143 ", "6145550143"],
  ["26145550143", null],
  ["5550143", null],
  ["+447700900123", null],
  ["614555017", null],
  ["", null],
  [null, null],
];

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let spSeq = 0;
async function attempt(fn) {
  const sp = `probe_attempt_${++spSeq}`;
  await c.query(`savepoint ${sp}`);
  try {
    const value = await fn();
    await c.query(`release savepoint ${sp}`);
    return { ok: true, value };
  } catch (e) {
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
    return { ok: false, code: e.code, message: e.message };
  }
}
/** Runs fn as a role. On an error the caller's savepoint rollback undoes the role. */
async function as(role, id, fn) {
  await c.query(`set local role ${role}`);
  if (id) {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
      JSON.stringify({ sub: id, role, aud: "authenticated" }),
      id,
    ]);
  }
  const value = await fn();
  await c.query("reset role");
  await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  return value;
}
const svc = (sql, params) => attempt(() => as("service_role", null, () => q(sql, params)));
const staff = (sql, params) => attempt(() => as("authenticated", LARRY, () => q(sql, params)));
const refusedWith = (r, code) => !r.ok && r.code === code;

let msgSeq = 0;
const T0 = Date.parse("2026-11-13T15:00:00Z");
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
async function record(sender, kind, keyword, minutes, reviewText = null, messageId = null) {
  const mid = messageId ?? `probe-${TAG}-${++msgSeq}`;
  const r = await svc(`select public.record_sms_inbound($1, $2, $3, $4, $5, $6, $7) as r`, [
    mid,
    `wh-${TAG}-${msgSeq}-${Math.random().toString(36).slice(2, 6)}`,
    sender,
    kind,
    keyword,
    at(minutes),
    reviewText,
  ]);
  return { ...r, mid, result: r.ok ? r.value[0].r : null };
}
const consentOf = async (ids) =>
  (await q(`select sms_consent from public.customers where id = any($1::uuid[]) order by id`, [ids])).map((r) => r.sms_consent);
const consentRows = async (ids) =>
  q(`select source, granted, (recorded_by = $2::uuid) as by_larry from public.consent_records where customer_id = any($1::uuid[]) order by recorded_at, source`, [ids, LARRY]);
const block = async (phone) => {
  const r = await svc(`select public.sms_block_status($1) as s`, [phone]);
  return r.ok ? r.value[0].s : `ERROR ${r.code}`;
};
const optRow = async (key) => (await q(`select status, last_keyword from public.sms_opt_outs where phone_key = $1`, [key]))[0] ?? null;

const catalog = async () => ({
  functions: await q(`select p.oid::regprocedure::text as fn, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5,
      p.prosecdef as definer, coalesce(p.proacl::text, '') as acl
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and not (p.proname = any($1)) order by 1`, [NEW_FUNCTIONS]),
  tables: await q(`select relname, coalesce(relacl::text, '') as acl, relrowsecurity as rls from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' and not (relname = any($1)) order by 1`, [NEW_TABLES]),
  policies: await q(`select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies
    where schemaname = 'public' and not (tablename = any($1)) order by 1, 2`, [NEW_TABLES]),
  constraints: await q(`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
    where connamespace = 'public'::regnamespace and conrelid <> 0 and not (conname = any($1))
      and not (conrelid::regclass::text = any($2)) order by 1, 2`, [CHANGED_CONSTRAINTS, NEW_TABLES.map((t) => `sms_${t.slice(4)}`).concat(NEW_TABLES)]),
  counts: (await q(`select (select count(*) from public.customers)::int as customers, (select count(*) from public.consent_records)::int as consent_records,
      (select count(*) from public.notifications_log)::int as notifications_log`))[0],
});

await c.connect();
await c.query("begin");
try {
  const [pre] = await q(`select to_regclass('public.sms_opt_outs') is not null as exists`);
  const already = pre.exists;
  const before = await catalog();
  console.log(`migration file: ${MIGRATION}`);
  console.log(`before: ${before.functions.length} functions, ${before.tables.length} tables, ${before.policies.length} policies, ${before.constraints.length} other constraints; rows ${JSON.stringify(before.counts)}`);
  if (already) console.log("NOTE  sms_opt_outs already exists: the migration is applied; probing the live definitions (not re-running it)");
  else {
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    console.log("applied the migration inside the transaction");
  }
  const after = await catalog();

  // --- nothing else changed ------------------------------------------------
  const md5Diff = after.functions.filter((f, i) => !same(f, before.functions[i])).map((f) => f.fn);
  ok(`every existing public function unchanged (md5, DEFINER, ACL): ${after.functions.length}`, same(before.functions, after.functions), md5Diff);
  ok(`every existing table's ACL and RLS unchanged: ${after.tables.length}`, same(before.tables, after.tables));
  ok(`every existing policy unchanged: ${after.policies.length}`, same(before.policies, after.policies));
  ok(`every other existing constraint unchanged: ${after.constraints.length}`, same(before.constraints, after.constraints));
  ok("row counts unchanged (customers, consent_records, notifications_log)", same(before.counts, after.counts), after.counts);
  for (const [name, fn] of [
    ["notification_health()", "public.notification_health()"],
    ["create_booking (13 args)", "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)"],
    ["_create_booking_core (16 args)", "public._create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)"],
    ["record_pay_link_payment", "public.record_pay_link_payment(uuid,uuid,text,numeric,boolean)"],
    ["staff_create_pay_link_booking", "public.staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid,text)"],
  ]) {
    const b = before.functions.find((f) => f.fn === fn.replace("public.", ""));
    const a = after.functions.find((f) => f.fn === fn.replace("public.", ""));
    console.log(`      md5 ${name}: ${b?.md5} -> ${a?.md5}`);
  }
  for (const t of ["customers", "consent_records", "notifications_log"]) {
    const b = before.tables.find((x) => x.relname === t);
    const a = after.tables.find((x) => x.relname === t);
    console.log(`      ACL ${t}: ${b?.acl} -> ${a?.acl}`);
  }

  // --- the two changed constraints -------------------------------------------
  const [cs] = await q(`select pg_get_constraintdef(oid) as def, convalidated from pg_constraint where conname = 'consent_records_source_check'`);
  ok("consent_records source check: + sms_reply, staff_review, validated", cs.def === CONSENT_CHECK && cs.convalidated, cs.def);
  const [fc] = await q(`select pg_get_constraintdef(oid) as def, convalidated from pg_constraint where conname = 'notifications_log_failure_category_check'`);
  ok("notifications_log failure_category check: + opted_out, validated", fc.def === FAILURE_CHECK && fc.convalidated, fc.def);

  // --- new tables ------------------------------------------------------------
  for (const t of NEW_TABLES) {
    const [r] = await q(`select relacl::text as acl, relrowsecurity as rls from pg_class where oid = ('public.' || $1)::regclass`, [t]);
    const pols = await q(`select policyname, cmd, qual from pg_policies where schemaname = 'public' and tablename = $1`, [t]);
    const [p] = await q(`select has_table_privilege('authenticated', 'public.' || $1, 'SELECT') as a_sel,
        has_table_privilege('authenticated', 'public.' || $1, 'INSERT,UPDATE,DELETE') as a_write,
        has_table_privilege('anon', 'public.' || $1, 'SELECT,INSERT,UPDATE,DELETE') as anon_any`, [t]);
    ok(`${t}: RLS on, one staff-read policy, authenticated SELECT only, anon nothing`,
      r.rls && pols.length === 1 && pols[0].cmd === "SELECT" && pols[0].qual === "is_staff()" && same(p, { a_sel: true, a_write: false, anon_any: false }),
      { acl: r.acl, policies: pols.map((x) => x.policyname), ...p });
  }

  // --- function grants ----------------------------------------------------------
  const fns = await q(`select p.proname as fn, p.prosecdef as definer,
      has_function_privilege('anon', p.oid, 'execute') as anon_x,
      has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
      has_function_privilege('service_role', p.oid, 'execute') as svc_x,
      coalesce(array_to_string(p.proconfig, ','), '') as config
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) order by 1`, [NEW_FUNCTIONS]);
  const want = {
    _apply_sms_opt_out: { definer: false, anon_x: false, auth_x: false, svc_x: false },
    _sms_phone_key: { definer: false, anon_x: false, auth_x: false, svc_x: false },
    purge_sms_review_text: { definer: false, anon_x: false, auth_x: false, svc_x: true },
    record_sms_inbound: { definer: true, anon_x: false, auth_x: false, svc_x: true },
    resolve_sms_review: { definer: true, anon_x: false, auth_x: true, svc_x: false },
    sms_block_status: { definer: true, anon_x: false, auth_x: false, svc_x: true },
  };
  for (const f of fns) {
    const { fn, config, ...got } = f;
    ok(`${fn}: ${got.definer ? "DEFINER" : "INVOKER"}, execute anon/auth/service = ${got.anon_x}/${got.auth_x}/${got.svc_x}, search_path pinned`,
      same(got, want[fn]) && config === "search_path=\"\"", { config });
  }
  ok("all six functions exist", fns.length === 6, fns.map((f) => f.fn));

  // --- phone key ---------------------------------------------------------------
  const keys = await q(`select public._sms_phone_key(x) as k from unnest($1::text[]) with ordinality as t(x, n) order by n`, [KEY_CASES.map((k) => k[0])]);
  const keyMiss = KEY_CASES.filter(([, w], i) => keys[i].k !== w).map(([i]) => i);
  ok(`_sms_phone_key: ${KEY_CASES.length} cases`, keyMiss.length === 0, keyMiss);

  // --- behaviour ----------------------------------------------------------------
  // The probe's numbers (614-555-0143 .. 0150, a fictional range) must belong to
  // no real customer or driver, or the counts below would include real rows.
  const [{ n: taken }] = await q(`select count(*)::int as n from (
      select phone from public.customers union all select phone from public.drivers) p
    where public._sms_phone_key(p.phone) between '6145550143' and '6145550150'`);
  if (taken > 0) throw new Error(`probe numbers 614-555-0143..0150 are in use by ${taken} real row(s); pick another free block`);
  ok("probe numbers 614-555-0143..0150 belong to no customer or driver", taken === 0);

  const cust = await q(`insert into public.customers (full_name, phone, sms_consent) values
      ('B4 probe ${TAG} A', '614-555-0143', true), ('B4 probe ${TAG} B', '(614) 555-0143', true),
      ('B4 probe ${TAG} C', '6145550144', true), ('B4 probe ${TAG} D', '614.555.0145', true),
      ('B4 probe ${TAG} E', '614-555-0146', false) returning id`);
  const [A, B, C, D, E] = cust.map((r) => r.id);
  const AB = [A, B].sort();

  // STOP
  let r = await record("+16145550143", "opt_out", "STOP", 0);
  ok("STOP recorded: both customers on that number matched", r.ok && r.result.status === "recorded" && r.result.matched === 2 && !r.result.needs_review, r.result ?? r.code);
  ok("  both customers' sms_consent now false", same(await consentOf(AB), [false, false]));
  ok("  one consent_records row each: sms_reply, granted false", same(await consentRows(AB), [
    { source: "sms_reply", granted: false, by_larry: null }, { source: "sms_reply", granted: false, by_larry: null },
  ]), await consentRows(AB));
  ok("  sms_opt_outs: opted_out, STOP", same(await optRow("6145550143"), { status: "opted_out", last_keyword: "STOP" }));
  ok("  sms_block_status for 614-555-0143 and (614) 555-0143: opted_out", (await block("614-555-0143")) === "opted_out" && (await block("(614) 555-0143")) === "opted_out");
  const [ev] = await q(`select customer_ids, review_text, needs_review from public.sms_inbound_events where message_id = $1`, [r.mid]);
  ok("  event stores the matched customer ids, no text, no review", same([...ev.customer_ids].sort(), AB) && ev.review_text === null && !ev.needs_review);

  // duplicate
  const dup = await record("+16145550143", "opt_out", "STOP", 1, null, r.mid);
  ok("same message id again (new delivery id): duplicate, nothing added", dup.ok && dup.result.status === "duplicate" && (await consentRows(AB)).length === 2, dup.result);

  // START
  r = await record("+16145550143", "opt_in", "START", 10);
  ok("START: opted_in, block lifted", r.ok && same(await optRow("6145550143"), { status: "opted_in", last_keyword: "START" }) && (await block("6145550143")) === null, r.result);
  ok("  START does NOT restore consent", same(await consentOf(AB), [false, false]));

  // an older STOP arriving late
  r = await record("16145550143", "opt_out", "QUIT", 5);
  ok("older QUIT arriving after START: recorded, but the number stays opted_in", r.ok && r.result.status === "recorded" && (await optRow("6145550143")).status === "opted_in" && (await block("6145550143")) === null, await optRow("6145550143"));
  ok("  consent stays false; its consent_records rows are still written", same(await consentOf(AB), [false, false]) && (await consentRows(AB)).length === 4);

  // UNSTOP then a newer STOPALL
  await record("6145550143", "opt_in", "UNSTOP", 20);
  r = await record("6145550143", "opt_out", "STOPALL", 30);
  ok("newer STOPALL after UNSTOP: opted_out again", (await optRow("6145550143")).status === "opted_out", await optRow("6145550143"));

  // CANCEL
  r = await record("+16145550144", "opt_out", "CANCEL", 0);
  const [cancelEv] = await q(`select id, needs_review, review_reason, review_text from public.sms_inbound_events where message_id = $1`, [r.mid]);
  ok("CANCEL: opted out AND flagged cancel_keyword, no text stored", r.ok && r.result.needs_review && (await block("6145550144")) === "opted_out" &&
    same({ ...cancelEv, id: undefined }, { id: undefined, needs_review: true, review_reason: "cancel_keyword", review_text: null }) && same(await consentOf([C]), [false]), cancelEv);

  // review (long-form STOP)
  r = await record("614-555-0145", "review", "STOP", 0, "Please stop texting me about the dumpster");
  const [revEv] = await q(`select id, needs_review, review_reason, review_text from public.sms_inbound_events where message_id = $1`, [r.mid]);
  ok("opt-out word inside a longer message: flagged, text kept, consent untouched", r.ok && revEv.needs_review && revEv.review_reason === "keyword_in_message" &&
    revEv.review_text === "Please stop texting me about the dumpster" && same(await consentOf([D]), [true]), revEv);
  ok("  texts to that number are BLOCKED until resolved (pending_review)", (await block("6145550145")) === "pending_review");
  ok("  no sms_opt_outs row for it", (await optRow("6145550145")) === null);

  // resolve as staff: not a stop
  let res = await staff(`select public.resolve_sms_review($1, 'not_a_stop') as r`, [revEv.id]);
  ok("staff resolve not_a_stop: block lifted, consent unchanged, text kept for the purge", res.ok && (await block("6145550145")) === null &&
    same(await consentOf([D]), [true]) && (await q(`select review_text from public.sms_inbound_events where id = $1`, [revEv.id]))[0].review_text !== null, res.value?.[0].r ?? res.code);
  const [resolved] = await q(`select review_outcome, (reviewed_by = $2::uuid) as by_larry, reviewed_at is not null as at from public.sms_inbound_events where id = $1`, [revEv.id, LARRY]);
  ok("  recorded who and when", same(resolved, { review_outcome: "not_a_stop", by_larry: true, at: true }));
  res = await staff(`select public.resolve_sms_review($1, 'not_a_stop') as r`, [revEv.id]);
  ok("  same outcome again: already_resolved (idempotent)", res.ok && res.value[0].r.status === "already_resolved");
  res = await staff(`select public.resolve_sms_review($1, 'treated_as_stop') as r`, [revEv.id]);
  ok("  a different outcome afterwards: refused 22023", refusedWith(res, "22023"), res.code);

  // review -> treated as stop
  r = await record("614-555-0145", "review", "UNSUBSCRIBE", 60, "how do i unsubscribe from these");
  const [rev2] = await q(`select id from public.sms_inbound_events where message_id = $1`, [r.mid]);
  res = await staff(`select public.resolve_sms_review($1, 'treated_as_stop') as r`, [rev2.id]);
  ok("staff resolve treated_as_stop: opted out, consent false, consent row staff_review by the staff member", res.ok && (await block("6145550145")) === "opted_out" &&
    same(await consentOf([D]), [false]) && same(await consentRows([D]), [{ source: "staff_review", granted: false, by_larry: true }]), await consentRows([D]));

  // CANCEL resolution rules
  res = await staff(`select public.resolve_sms_review($1, 'treated_as_stop') as r`, [cancelEv.id]);
  ok("CANCEL row: treated_as_stop refused 22023", refusedWith(res, "22023"), res.code);
  res = await staff(`select public.resolve_sms_review($1, 'checked') as r`, [cancelEv.id]);
  ok("CANCEL row: checked accepted; texts stay stopped", res.ok && (await block("6145550144")) === "opted_out", res.value?.[0].r ?? res.code);

  // not reviewable
  const [plainStop] = await q(`select id from public.sms_inbound_events where keyword = 'STOP' and kind = 'opt_out' and phone_key = '6145550143' limit 1`);
  res = await staff(`select public.resolve_sms_review($1, 'checked') as r`, [plainStop.id]);
  ok("a plain STOP has nothing to review: refused 22023", refusedWith(res, "22023"), res.code);
  res = await staff(`select public.resolve_sms_review($1, 'checked') as r`, [crypto.randomUUID()]);
  ok("an unknown event id: refused 22023", refusedWith(res, "22023"), res.code);

  // numbers with no customer, and non-US
  r = await record("+16145550147", "opt_out", "END", 0);
  ok("a number with no customer: opted out, 0 matched", r.ok && r.result.matched === 0 && (await block("6145550147")) === "opted_out", r.result);
  r = await record("+447700900123", "opt_out", "STOP", 0);
  ok("a non-US number: recorded, no key, no opt-out row, not blocked", r.ok && r.result.has_number === false &&
    (await q(`select count(*)::int as n from public.sms_opt_outs where last_message_id = $1`, [r.mid]))[0].n === 0 && (await block("+447700900123")) === null, r.result);
  ok("customer E (consent false, different number) untouched", same(await consentOf([E]), [false]) && (await consentRows([E])).length === 0);

  // refusals
  const bad = [
    ["opt_in with STOP", ["+16145550148", "opt_in", "STOP", 0]],
    ["review with START", ["+16145550148", "review", "START", 0]],
    ["unknown kind", ["+16145550148", "maybe", "STOP", 0]],
    ["lowercase keyword", ["+16145550148", "opt_out", "stop", 0]],
    ["HELP", ["+16145550148", "opt_out", "HELP", 0]],
    ["review text on an opt_out", ["+16145550148", "opt_out", "STOP", 0, "STOP"]],
    ["review text over 500 characters", ["+16145550148", "review", "STOP", 0, "x".repeat(501)]],
  ];
  for (const [label, args] of bad) {
    const x = await record(...args);
    ok(`refused 22023: ${label}`, refusedWith(x, "22023"), x.code);
  }
  let x = await svc(`select public.record_sms_inbound('', 'wh', '+16145550148', 'opt_out', 'STOP', now(), null)`);
  ok("refused 22023: empty message id", refusedWith(x, "22023"), x.code);
  x = await svc(`select public.record_sms_inbound('m-${TAG}-null', 'wh', '+16145550148', 'opt_out', 'STOP', null, null)`);
  ok("refused 22023: no received time", refusedWith(x, "22023"), x.code);
  ok("nothing recorded for 6145550148", (await q(`select count(*)::int as n from public.sms_inbound_events where phone_key = '6145550148'`))[0].n === 0);

  // purge
  await q(`update public.sms_inbound_events set reviewed_at = now() - interval '31 days' where id = $1`, [revEv.id]);
  await q(`update public.sms_inbound_events set reviewed_at = now() - interval '29 days' where id = $1`, [rev2.id]);
  x = await svc(`select public.purge_sms_review_text(30) as n`);
  const texts = await q(`select id = $1 as first, review_text is null as blank, review_text_purged_at is not null as stamped from public.sms_inbound_events where id = any($2::uuid[]) order by first desc`, [revEv.id, [revEv.id, rev2.id]]);
  ok("purge(30): clears text resolved 31 days ago, keeps 29 days ago", x.ok && x.value[0].n >= 1 &&
    same(texts, [{ first: true, blank: true, stamped: true }, { first: false, blank: false, stamped: false }]), texts);
  x = await svc(`select public.purge_sms_review_text(30) as n`);
  ok("purge again: 0", x.ok && x.value[0].n === 0, x.value?.[0]);
  x = await svc(`select public.purge_sms_review_text(29) as n`);
  ok("purge(29): refused 22023", refusedWith(x, "22023"), x.code);
  const unresolved = await record("614-555-0149", "review", "STOP", 0, "stop sending");
  await q(`update public.sms_inbound_events set created_at = now() - interval '90 days' where message_id = $1`, [unresolved.mid]);
  await svc(`select public.purge_sms_review_text(30)`);
  ok("unresolved review text is never purged", (await q(`select review_text from public.sms_inbound_events where message_id = $1`, [unresolved.mid]))[0].review_text === "stop sending");

  // --- privileges as each role -----------------------------------------------------
  const STAFF_READ = `select (select count(*) from public.sms_opt_outs where phone_key between '6145550143' and '6145550150')::int as o,
    (select count(*) from public.sms_inbound_events where message_id like 'probe-${TAG}-%')::int as e`;
  const sr = await staff(STAFF_READ);
  ok("staff read both tables", sr.ok && sr.value[0].o >= 4 && sr.value[0].e >= 10, sr.value?.[0]);
  const nr = await attempt(() => as("authenticated", NOBODY, () => q(STAFF_READ)));
  ok("signed-in non-staff read nothing", nr.ok && same(nr.value[0], { o: 0, e: 0 }), nr.value?.[0]);
  const ar = await attempt(() => as("anon", null, () => q(`select count(*) from public.sms_opt_outs`)));
  ok("anon refused on sms_opt_outs (42501)", refusedWith(ar, "42501"), ar.code);
  const ar2 = await attempt(() => as("anon", null, () => q(`select count(*) from public.sms_inbound_events`)));
  ok("anon refused on sms_inbound_events (42501)", refusedWith(ar2, "42501"), ar2.code);
  const calls = [
    ["staff: record_sms_inbound", "authenticated", LARRY, `select public.record_sms_inbound('m', 'w', '+16145550150', 'opt_out', 'STOP', now(), null)`],
    ["staff: sms_block_status", "authenticated", LARRY, `select public.sms_block_status('6145550143')`],
    ["staff: purge_sms_review_text", "authenticated", LARRY, `select public.purge_sms_review_text(30)`],
    ["staff: _apply_sms_opt_out", "authenticated", LARRY, `select public._apply_sms_opt_out('6145550150', 'STOP', 'm', now(), 'sms_reply', null)`],
    ["staff: insert into sms_opt_outs", "authenticated", LARRY, `insert into public.sms_opt_outs values ('6145550150', 'opted_out', 'STOP', 'm', now(), now(), null, now())`],
    ["staff: update sms_inbound_events", "authenticated", LARRY, `update public.sms_inbound_events set review_text = null`],
    ["service_role: resolve_sms_review", "service_role", null, `select public.resolve_sms_review('${revEv.id}', 'not_a_stop')`],
    ["service_role: _apply_sms_opt_out", "service_role", null, `select public._apply_sms_opt_out('6145550150', 'STOP', 'm', now(), 'sms_reply', null)`],
    ["service_role: _sms_phone_key", "service_role", null, `select public._sms_phone_key('6145550150')`],
    ["anon: resolve_sms_review", "anon", null, `select public.resolve_sms_review('${revEv.id}', 'not_a_stop')`],
    ["anon: record_sms_inbound", "anon", null, `select public.record_sms_inbound('m', 'w', '+16145550150', 'opt_out', 'STOP', now(), null)`],
    ["non-staff: resolve_sms_review", "authenticated", NOBODY, `select public.resolve_sms_review('${rev2.id}', 'not_a_stop')`],
  ];
  for (const [label, role, id, sql] of calls) {
    const y = await attempt(() => as(role, id, () => q(sql)));
    ok(`refused 42501: ${label}`, refusedWith(y, "42501"), y.ok ? "allowed" : y.code);
  }
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures === 0 ? "\nALL PASS (rolled back)" : `\n${failures} FAILED (rolled back)`);
process.exit(failures === 0 ? 0 : 1);
