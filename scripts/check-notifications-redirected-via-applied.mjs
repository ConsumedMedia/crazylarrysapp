// Read-only check of the APPLIED 20261112000000_notifications_log_redirected_via migration.
//
//   node --use-system-ca scripts/check-notifications-redirected-via-applied.mjs   (repo root; reads DATABASE_URL from .env.local)
//
// One READ ONLY transaction, rolled back. Reads the catalogs, then switches to
// role authenticated / anon only to see what real accounts can read. Nothing is
// written. Prints counts and variable names only, never recipients.
import fs from "node:fs";
import pg from "pg";

const VERSION = "20261112000000";
const LARRY = "923ed11f-196b-4939-9639-f576b4d88c87"; // owner (staff)
const CONSTRAINT =
  "CHECK (((redirected_via IS NULL) OR ((original_recipient IS NOT NULL) AND (((redirected_via = 'CL_NOTIFICATIONS_TEST_PHONE'::text) AND (channel = 'sms'::notification_channel)) OR ((redirected_via = 'CL_NOTIFICATIONS_TEST_EMAIL'::text) AND (channel = 'email'::notification_channel)) OR (redirected_via = 'CL_NOTIFICATIONS_TEST_TO'::text)))))";
// Live before the migration (read 2026-11-12); the migration must not change them.
const ACL = "{postgres=arwdDxtm/postgres,authenticated=arwdm/postgres,service_role=arwdDxtm/postgres}";
const HEALTH_MD5 = "b8dc990080f14fbaacf713014eace6ba";
const FAILURE_CHECK =
  "CHECK (((failure_category IS NULL) OR (failure_category = ANY (ARRAY['disabled'::text, 'test_mode'::text, 'not_configured'::text, 'account_blocked'::text, 'provider_rejected'::text, 'rate_limited'::text, 'transient'::text, 'recipient_missing'::text, 'no_consent'::text]))))";
// Migration 20261113000000 (Plan B.4, SMS opt-outs) adds 'opted_out'; that is
// the only other version this check accepts.
const FAILURE_CHECK_B4 =
  "CHECK (((failure_category IS NULL) OR (failure_category = ANY (ARRAY['disabled'::text, 'test_mode'::text, 'not_configured'::text, 'account_blocked'::text, 'provider_rejected'::text, 'rate_limited'::text, 'transient'::text, 'recipient_missing'::text, 'no_consent'::text, 'opted_out'::text]))))";
const POLICIES = [
  {
    policyname: "notifications_log: driver reads own",
    cmd: "SELECT",
    roles: "{public}",
    qual: "(EXISTS ( SELECT 1\n   FROM drivers d\n  WHERE ((d.id = notifications_log.driver_id) AND (d.profile_id = auth.uid()) AND d.active)))",
    with_check: null,
  },
  { policyname: "notifications_log: staff full access", cmd: "ALL", roles: "{public}", qual: "is_staff()", with_check: "is_staff()" },
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

  const [col] = await q(`select data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications_log' and column_name = 'redirected_via'`);
  ok("redirected_via is text, nullable, no default", same(col, { data_type: "text", is_nullable: "YES", column_default: null }), col ?? "missing");
  if (!col) throw Object.assign(new Error("not applied"), { notApplied: true });

  const [con] = await q(`select pg_get_constraintdef(oid) as def, convalidated from pg_constraint
    where conrelid = 'public.notifications_log'::regclass and conname = 'notifications_log_redirected_via_check'`);
  ok("redirected_via check constraint is exactly as probed, and validated", con?.def === CONSTRAINT && con?.convalidated === true, con?.def ?? "missing");
  const [fc] = await q(`select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.notifications_log'::regclass and conname = 'notifications_log_failure_category_check'`);
  ok(
    "failure_category check unchanged (or B.4's version with opted_out)",
    fc?.def === FAILURE_CHECK || fc?.def === FAILURE_CHECK_B4,
    fc?.def === FAILURE_CHECK_B4 ? "B.4 version" : undefined,
  );

  const [acl] = await q(`select relacl::text as acl, relrowsecurity as rls from pg_class where oid = 'public.notifications_log'::regclass`);
  ok("table ACL unchanged, RLS on", acl.acl === ACL && acl.rls === true, acl);
  const colAcl = await q(`select attname from pg_attribute where attrelid = 'public.notifications_log'::regclass and attnum > 0 and not attisdropped and attacl is not null`);
  ok("no column-level grants", colAcl.length === 0, colAcl.map((r) => r.attname));
  const [priv] = await q(`select has_column_privilege('authenticated', 'public.notifications_log', 'redirected_via', 'SELECT') as auth_sel,
      has_column_privilege('anon', 'public.notifications_log', 'redirected_via', 'SELECT') as anon_sel,
      has_column_privilege('service_role', 'public.notifications_log', 'redirected_via', 'INSERT') as svc_ins`);
  ok("authenticated can SELECT it, anon can't, service_role can INSERT", same(priv, { auth_sel: true, anon_sel: false, svc_ins: true }), priv);

  const policies = await q(`select policyname, cmd, roles::text as roles, qual, with_check from pg_policies
    where schemaname = 'public' and tablename = 'notifications_log' order by policyname`);
  ok("both policies unchanged", same(policies, POLICIES), policies.map((p) => p.policyname));

  const [h] = await q(`select md5(replace(pg_get_functiondef('public.notification_health()'::regprocedure), chr(13), '')) as md5`);
  ok("notification_health() unchanged", h.md5 === HEALTH_MD5, h.md5);
  const trig = await q(`select tgname from pg_trigger where tgrelid = 'public.notifications_log'::regclass and not tgisinternal`);
  ok("no triggers on notifications_log", trig.length === 0, trig.map((t) => t.tgname));

  const byName = await q(`select coalesce(redirected_via, '(null)') as via, (original_recipient is not null) as redirected, count(*)::int as n
    from public.notifications_log group by 1, 2 order by 1, 2`);
  console.log(`      rows by name: ${JSON.stringify(byName)}`);
  ok("no name on a row that wasn't redirected", !byName.some((r) => r.via !== "(null)" && !r.redirected));

  const staff = await readAs("authenticated", LARRY, `select count(*)::int as n, count(redirected_via)::int as named from public.notifications_log`);
  ok("staff (owner) can read the column through RLS", staff.ok && staff.rows[0].n > 0, staff.ok ? staff.rows[0] : staff.code);
  const anon = await readAs("anon", null, `select redirected_via from public.notifications_log limit 1`);
  ok("anon is refused (42501)", !anon.ok && anon.code === "42501", anon.ok ? "read" : anon.code);
} catch (e) {
  if (!e.notApplied) throw e;
  console.log("\nThe column isn't there: the migration is not applied. Nothing else checked.");
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
