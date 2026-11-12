// Rolled-back probe for supabase/migrations/20261112000000_notifications_log_redirected_via.sql.
//
//   node --use-system-ca scripts/probe-notifications-redirected-via.mjs   (repo root; reads DATABASE_URL from .env.local)
//   PROBE_MIGRATION=<file> ...   probes another copy of the migration (mutation runs)
//
// Everything runs in ONE transaction that is always rolled back (finally): the
// migration itself and every probe row. Real rows are only READ. Prints no
// email addresses or phone numbers.
//
// Safe to re-run after the migration is applied: the column then already
// exists, the migration is not re-run, and the live definition is probed.
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const MIGRATION = process.env.PROBE_MIGRATION || "supabase/migrations/20261112000000_notifications_log_redirected_via.sql";
const LARRY = "923ed11f-196b-4939-9639-f576b4d88c87"; // owner (staff)
const MARCUS = "a1010b9b-2268-49a5-9118-0ef82ea5442a"; // active test driver
const NOBODY = crypto.randomUUID(); // signed in, no profile: not staff, not a driver
const TAG = crypto.randomUUID().slice(0, 8);
const PHONE = "CL_NOTIFICATIONS_TEST_PHONE";
const EMAIL = "CL_NOTIFICATIONS_TEST_EMAIL";
const TO = "CL_NOTIFICATIONS_TEST_TO";

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
async function as(role, id, fn) {
  await c.query(`set local role ${role}`);
  if (id) {
    await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
      JSON.stringify({ sub: id, role, aud: "authenticated" }),
      id,
    ]);
  }
  // On an error the transaction is aborted, so nothing can run here; the
  // caller's savepoint rollback undoes the set local role and the claims. Reset
  // only after a success (resetting in a finally would replace the real error
  // code with 25P02).
  const value = await fn();
  await c.query("reset role");
  await q(`select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`);
  return value;
}

const snapshot = async () => ({
  acl: (await q(`select relacl::text as acl, relrowsecurity as rls from pg_class where oid = 'public.notifications_log'::regclass`))[0],
  policies: await q(`select policyname, cmd, roles::text as roles, permissive, qual, with_check from pg_policies
    where schemaname = 'public' and tablename = 'notifications_log' order by policyname`),
  otherConstraints: await q(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.notifications_log'::regclass and conname <> 'notifications_log_redirected_via_check' order by conname`),
  health: (await q(`select md5(replace(pg_get_functiondef('public.notification_health()'::regprocedure), chr(13), '')) as md5`))[0].md5,
  columnAcl: await q(`select attname, attacl::text from pg_attribute where attrelid = 'public.notifications_log'::regclass
    and attnum > 0 and not attisdropped and attacl is not null`),
  triggers: await q(`select tgname from pg_trigger where tgrelid = 'public.notifications_log'::regclass and not tgisinternal`),
  rows: (await q(`select count(*)::int as n from public.notifications_log`))[0].n,
});

/** One probe row, inserted as service_role (the app's writer). */
async function insert(fields) {
  const cols = Object.keys(fields);
  const sql = `insert into public.notifications_log (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`;
  return attempt(() => as("service_role", null, () => q(sql, Object.values(fields))));
}
const row = (channel, over = {}) => ({
  type: "booking_confirmation",
  channel,
  recipient: channel === "sms" ? `+1614555${TAG.replace(/\D/g, "0").slice(0, 4)}` : `rv-probe-${TAG}@example.com`,
  delivery_status: "sent",
  body: `redirected_via probe ${TAG}`,
  ...over,
});
const redirected = (channel, via) =>
  row(channel, { original_recipient: channel === "sms" ? "+16145550100" : `rv-probe-${TAG}-orig@example.com`, redirected_via: via });

await c.connect();
await c.query("begin");
try {
  const [pre] = await q(`select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications_log' and column_name = 'redirected_via'`);
  const already = pre.n === 1;
  const before = await snapshot();
  console.log(`migration file: ${MIGRATION}`);
  console.log(`before: rows=${before.rows} acl=${before.acl.acl} rls=${before.acl.rls} policies=${before.policies.length} health md5=${before.health}`);

  if (already) {
    console.log("NOTE  redirected_via already exists: the migration is applied; probing the live definition (not re-running it)");
  } else {
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    console.log("applied the migration inside the transaction");
  }
  const after = await snapshot();

  // --- shape ---------------------------------------------------------------
  const [col] = await q(`select data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'notifications_log' and column_name = 'redirected_via'`);
  ok("column is text, nullable, no default", same(col, { data_type: "text", is_nullable: "YES", column_default: null }), col);
  const [con] = await q(`select pg_get_constraintdef(oid) as def, convalidated from pg_constraint
    where conrelid = 'public.notifications_log'::regclass and conname = 'notifications_log_redirected_via_check'`);
  ok("check constraint exists and is validated", !!con && con.convalidated === true, con && con.convalidated);
  console.log(`      ${con?.def}`);

  // --- nothing else changed ------------------------------------------------
  ok("table ACL unchanged", same(before.acl, after.acl), after.acl.acl);
  ok("no column-level grants before or after", before.columnAcl.length === 0 && after.columnAcl.length === 0, after.columnAcl);
  ok("both policies unchanged (name, command, roles, qual, with_check)", same(before.policies, after.policies), after.policies.map((p) => p.policyname));
  ok("other constraints unchanged (failure_category check, keys)", same(before.otherConstraints, after.otherConstraints), after.otherConstraints.map((x) => x.conname));
  ok("notification_health() md5 unchanged", before.health === after.health, after.health);
  ok("no triggers added", same(before.triggers, after.triggers), after.triggers);
  ok("row count unchanged", before.rows === after.rows, after.rows);
  if (!already) {
    const [nn] = await q(`select count(*)::int as n from public.notifications_log where redirected_via is not null`);
    ok("every existing row is null (no backfill)", nn.n === 0, nn.n);
  }

  // --- privileges ----------------------------------------------------------
  const [priv] = await q(`select has_column_privilege('authenticated', 'public.notifications_log', 'redirected_via', 'SELECT') as auth_sel,
      has_column_privilege('anon', 'public.notifications_log', 'redirected_via', 'SELECT') as anon_sel,
      has_column_privilege('anon', 'public.notifications_log', 'redirected_via', 'INSERT') as anon_ins,
      has_column_privilege('service_role', 'public.notifications_log', 'redirected_via', 'INSERT') as svc_ins,
      has_column_privilege('service_role', 'public.notifications_log', 'redirected_via', 'SELECT') as svc_sel`);
  ok("authenticated SELECT yes, anon nothing, service_role INSERT and SELECT", same(priv, { auth_sel: true, anon_sel: false, anon_ins: false, svc_ins: true, svc_sel: true }), priv);

  // --- writes the app makes (as service_role) --------------------------------
  const accepted = [
    ["SMS redirected by TEST_PHONE", redirected("sms", PHONE)],
    ["email redirected by TEST_EMAIL", redirected("email", EMAIL)],
    ["SMS redirected by TEST_TO", redirected("sms", TO)],
    ["email redirected by TEST_TO", redirected("email", TO)],
    ["redirected, variable unknown (null)", redirected("sms", null)],
    ["not redirected, null", row("email", { redirected_via: null })],
    ["today's insert shape, not redirected (column not mentioned)", row("sms")],
    ["today's insert shape, redirected (column not mentioned)", row("email", { original_recipient: `rv-probe-${TAG}-orig@example.com` })],
    ["today's skipped/failed shapes", row("sms", { delivery_status: "skipped", failure_category: "test_mode", error: "probe" })],
  ];
  for (const [label, fields] of accepted) {
    const r = await insert(fields);
    ok(`accepted: ${label}`, r.ok, r.ok ? undefined : r.code);
  }
  const [stored] = await q(`select redirected_via from public.notifications_log where body = $1 and channel = 'sms' and redirected_via = $2`, [
    `redirected_via probe ${TAG}`,
    PHONE,
  ]);
  ok("the name is stored as given", stored?.redirected_via === PHONE, stored?.redirected_via);

  const refusedRows = [
    ["SMS with TEST_EMAIL", redirected("sms", EMAIL)],
    ["email with TEST_PHONE", redirected("email", PHONE)],
    ["a name with no original_recipient (not redirected)", row("sms", { redirected_via: TO })],
    ["an unknown name", redirected("sms", "CL_NOTIFICATIONS_TEST_X")],
    ["a lowercase name", redirected("sms", PHONE.toLowerCase())],
    ["a name with a trailing space", redirected("sms", `${PHONE} `)],
    ["an empty string", redirected("sms", "")],
    ["a value instead of a name (a phone number)", redirected("sms", "+16145550199")],
    ["a value instead of a name (an email address)", redirected("email", "tester@example.com")],
  ];
  for (const [label, fields] of refusedRows) {
    const r = await insert(fields);
    ok(`refused 23514: ${label}`, !r.ok && r.code === "23514", r.ok ? "accepted" : r.code);
  }

  // An update is checked too (staff can update log rows through RLS).
  const upd = await attempt(() =>
    q(`update public.notifications_log set redirected_via = $1 where body = $2 and channel = 'email' and original_recipient is null`, [
      EMAIL,
      `redirected_via probe ${TAG}`,
    ]),
  );
  ok("refused 23514: updating a non-redirected row to carry a name", !upd.ok && upd.code === "23514", upd.ok ? "accepted" : upd.code);

  // --- who can read it -------------------------------------------------------
  const [drv] = await q(`select id from public.drivers where profile_id = $1 and active`, [MARCUS]);
  ok("Marcus has an active driver row", !!drv);
  const own = await insert({ ...redirected("sms", PHONE), driver_id: drv?.id, body: `redirected_via probe ${TAG} driver` });
  ok("probe row on Marcus's driver id inserted", own.ok, own.ok ? undefined : own.code);
  const readSql = `select body, redirected_via from public.notifications_log where body like 'redirected_via probe ${TAG}%' order by body, redirected_via nulls first`;

  const staff = await as("authenticated", LARRY, () => q(readSql));
  ok(
    "staff (owner) reads every probe row, with the name",
    staff.length === 10 && staff.some((r) => r.redirected_via === EMAIL) && staff.some((r) => r.redirected_via === PHONE),
    { rows: staff.length, names: [...new Set(staff.map((r) => r.redirected_via))] },
  );
  const driver = await as("authenticated", MARCUS, () => q(readSql));
  ok(
    "Marcus reads only his own row, with the name",
    driver.length === 1 && driver[0].body.endsWith("driver") && driver[0].redirected_via === PHONE,
    driver.map((r) => r.redirected_via),
  );
  const nobody = await as("authenticated", NOBODY, () => q(readSql));
  ok("a signed-in non-staff account reads no rows", nobody.length === 0, nobody.length);
  const anon = await attempt(() => as("anon", null, () => q(readSql)));
  ok("anon is refused (42501)", !anon.ok && anon.code === "42501", anon.ok ? "read" : anon.code);
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures === 0 ? "\nALL PASS (rolled back)" : `\n${failures} FAILED (rolled back)`);
process.exit(failures === 0 ? 0 : 1);
