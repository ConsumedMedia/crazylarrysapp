// Read-only check of the APPLIED 20261113000000_sms_opt_outs migration (Plan B.4).
//
//   node --use-system-ca scripts/check-sms-opt-outs-applied.mjs   (repo root; reads DATABASE_URL from .env.local)
//
// One READ ONLY transaction, rolled back. Reads the catalogs, then switches to
// role authenticated / anon only to see what real accounts can read. Nothing is
// written and no function that writes is called. Prints counts only.
import fs from "node:fs";
import pg from "pg";

const VERSION = "20261113000000";
const LARRY = "923ed11f-196b-4939-9639-f576b4d88c87"; // owner (staff)

// Pinned from the rolled-back probe of the migration file (2026-11-13).
const FUNCTIONS = {
  "_apply_sms_opt_out(text,text,text,timestamp with time zone,text,uuid)": { md5: "a4ffb77a67b3381041d520001434b0ef", acl: "{postgres=X/postgres}", definer: false },
  "_sms_phone_key(text)": { md5: "bd10fc3fe9173918b7ebd30276b27ea8", acl: "{postgres=X/postgres}", definer: false },
  "purge_sms_review_text(integer)": { md5: "9c8891c16a64285dcc3bf49ce9c3ffa4", acl: "{postgres=X/postgres,service_role=X/postgres}", definer: false },
  "record_sms_inbound(text,text,text,text,text,timestamp with time zone,text)": { md5: "c0651900d3b36495494dca98e84bb687", acl: "{postgres=X/postgres,service_role=X/postgres}", definer: true },
  "resolve_sms_review(uuid,text)": { md5: "ed777c5581ad694a8c3092c640674dae", acl: "{postgres=X/postgres,authenticated=X/postgres}", definer: true },
  "sms_block_status(text)": { md5: "9a70c411fe1fe889af5be0b834f815cd", acl: "{postgres=X/postgres,service_role=X/postgres}", definer: true },
};
const TABLES = {
  sms_opt_outs: { constraints: 4, md5: "cbecec306e0a905357afda1a13f2da43" },
  sms_inbound_events: { constraints: 14, md5: "81caf72b7fbd1496f2cd87893ce10892" },
};
const NEW_TABLE_ACL = "{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres}";
const CONSENT_CHECK =
  "CHECK ((source = ANY (ARRAY['phone_verbal'::text, 'pay_page'::text, 'sms_reply'::text, 'staff_review'::text])))";
const FAILURE_CHECK =
  "CHECK (((failure_category IS NULL) OR (failure_category = ANY (ARRAY['disabled'::text, 'test_mode'::text, 'not_configured'::text, 'account_blocked'::text, 'provider_rejected'::text, 'rate_limited'::text, 'transient'::text, 'recipient_missing'::text, 'no_consent'::text, 'opted_out'::text]))))";
// Live before the migration (read 2026-11-13); the migration must not change them.
const UNCHANGED = {
  acl: {
    customers: "{postgres=arwdDxtm/postgres,authenticated=arwdm/postgres,service_role=arwdDxtm/postgres}",
    consent_records: "{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres}",
    notifications_log: "{postgres=arwdDxtm/postgres,authenticated=arwdm/postgres,service_role=arwdDxtm/postgres}",
  },
  md5: {
    "notification_health()": "b8dc990080f14fbaacf713014eace6ba",
    "create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)": "5caa6553fb3482439a75926ed8ab764a",
    "_create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)": "e8245ce0504d55f53bad223cba209d60",
    "record_pay_link_payment(uuid,uuid,text,numeric,boolean)": "192636dd498ac6c2249325d0fd4a0cb5",
    "staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid,text)": "80858bcbc28557d89113eb5aa7d586ee",
  },
};

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};
async function readAs(role, id, sql) {
  await c.query("savepoint r");
  try {
    await c.query(`set local role ${role}`);
    if (id) {
      await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
        JSON.stringify({ sub: id, role, aud: "authenticated" }),
        id,
      ]);
    }
    return { ok: true, rows: await q(sql) };
  } catch (e) {
    return { ok: false, code: e.code };
  } finally {
    await c.query("rollback to savepoint r");
  }
}

await c.connect();
await c.query("begin transaction read only");
try {
  const [m] = await q(`select bool_or(version = $1) as applied from supabase_migrations.schema_migrations`, [VERSION]);
  ok(`${VERSION} is recorded as applied`, m.applied === true);
  const [t] = await q(`select to_regclass('public.sms_opt_outs') is not null as a, to_regclass('public.sms_inbound_events') is not null as b`);
  if (!t.a || !t.b) {
    ok("sms_opt_outs and sms_inbound_events exist", false);
    throw Object.assign(new Error("not applied"), { notApplied: true });
  }

  for (const [tbl, want] of Object.entries(TABLES)) {
    const [r] = await q(`select c.relacl::text as acl, c.relrowsecurity as rls,
        (select count(*)::int from pg_constraint where conrelid = c.oid) as n,
        (select md5(string_agg(conname || ':' || replace(pg_get_constraintdef(oid), chr(13), ''), '|' order by conname)) from pg_constraint where conrelid = c.oid) as md5
      from pg_class c where c.oid = ('public.' || $1)::regclass`, [tbl]);
    ok(`${tbl}: ACL, RLS on, ${want.constraints} constraints exactly as probed`, r.acl === NEW_TABLE_ACL && r.rls && r.n === want.constraints && r.md5 === want.md5, r);
    const pols = await q(`select policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = $1`, [tbl]);
    ok(`${tbl}: one policy, staff read`, pols.length === 1 && pols[0].cmd === "SELECT" && pols[0].qual === "is_staff()" && pols[0].with_check === null && pols[0].roles === "{public}", pols.map((p) => p.policyname));
  }
  const [idx] = await q(`select indexdef from pg_indexes where indexname = 'sms_inbound_events_open_review_idx'`);
  ok("open-review index present", !!idx);

  for (const [fn, want] of Object.entries(FUNCTIONS)) {
    const [r] = await q(`select md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5, coalesce(p.proacl::text, '') as acl, p.prosecdef as definer,
        coalesce(array_to_string(p.proconfig, ','), '') as config
      from pg_proc p where p.oid = ('public.' || $1)::regprocedure`, [fn]);
    ok(`${fn.split("(")[0]}: md5, ACL, ${want.definer ? "DEFINER" : "INVOKER"}, search_path pinned`,
      r && r.md5 === want.md5 && r.acl === want.acl && r.definer === want.definer && r.config === 'search_path=""', r);
  }

  const [cs] = await q(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'consent_records_source_check'`);
  ok("consent_records source check includes sms_reply, staff_review", cs?.def === CONSENT_CHECK, cs?.def);
  const [fc] = await q(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_log_failure_category_check'`);
  ok("notifications_log failure_category check includes opted_out", fc?.def === FAILURE_CHECK, fc?.def);

  for (const [tbl, acl] of Object.entries(UNCHANGED.acl)) {
    const [r] = await q(`select relacl::text as acl from pg_class where oid = ('public.' || $1)::regclass`, [tbl]);
    ok(`${tbl} ACL unchanged`, r.acl === acl, r.acl);
  }
  for (const [fn, md5] of Object.entries(UNCHANGED.md5)) {
    const [r] = await q(`select md5(replace(pg_get_functiondef(('public.' || $1)::regprocedure), chr(13), '')) as md5`, [fn]);
    ok(`${fn.split("(")[0]} unchanged`, r.md5 === md5, r.md5);
  }

  const [counts] = await q(`select (select count(*) from public.sms_opt_outs)::int as opt_outs,
      (select count(*) from public.sms_opt_outs where status = 'opted_out')::int as opted_out,
      (select count(*) from public.sms_inbound_events)::int as events,
      (select count(*) from public.sms_inbound_events where needs_review and reviewed_at is null)::int as open_reviews,
      (select count(*) from public.consent_records where source in ('sms_reply', 'staff_review'))::int as sms_consent_rows`);
  console.log(`      rows: ${JSON.stringify(counts)}`);

  const staff = await readAs("authenticated", LARRY, `select count(*)::int as n from public.sms_inbound_events`);
  ok("staff (owner) can read sms_inbound_events", staff.ok, staff.ok ? staff.rows[0] : staff.code);
  const anon = await readAs("anon", null, `select 1 from public.sms_opt_outs limit 1`);
  ok("anon is refused on sms_opt_outs (42501)", !anon.ok && anon.code === "42501", anon.ok ? "read" : anon.code);
  const block = await readAs("authenticated", LARRY, `select public.sms_block_status('6145550100')`);
  ok("staff cannot call sms_block_status (42501)", !block.ok && block.code === "42501", block.ok ? "allowed" : block.code);
} catch (e) {
  if (!e.notApplied) throw e;
  console.log("\nThe tables aren't there: the migration is not applied. Nothing else checked.");
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
