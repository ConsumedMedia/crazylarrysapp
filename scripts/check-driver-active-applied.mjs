// Read-only check of the APPLIED 20261109010000_driver_access_requires_active migration.
//
//   node --use-system-ca scripts/check-driver-active-applied.mjs   (repo root; reads DATABASE_URL from .env.local)
//
// One READ ONLY transaction, rolled back. It reads the catalogs, then switches
// to role authenticated with real claims only to count what real accounts can
// read. Nothing is written and no function that writes is called.
import fs from "node:fs";
import pg from "pg";

const VERSION = "20261109010000";
const MARCUS = "a1010b9b-2268-49a5-9118-0ef82ea5442a"; // active test driver
const LARRY = "923ed11f-196b-4939-9639-f576b4d88c87"; // owner
const POLICIES = [
  ["public", "jobs", "jobs: driver reads assigned jobs", "SELECT", "{public}"],
  ["public", "bookings", "bookings: driver reads bookings on their jobs", "SELECT", "{public}"],
  ["public", "job_photos", "job_photos: driver reads own job photos", "SELECT", "{public}"],
  ["public", "job_photos", "job_photos: driver inserts own job photos", "INSERT", "{public}"],
  ["public", "trucks", "trucks: driver reads own assigned truck", "SELECT", "{public}"],
  ["public", "notifications_log", "notifications_log: driver reads own", "SELECT", "{public}"],
  ["storage", "objects", "job-photos: driver uploads own job photos", "INSERT", "{authenticated}"],
];
const FUNCTIONS = ["public.driver_can_see_customer(uuid)", "public.driver_can_see_dumpster(uuid)", "public.complete_job(uuid)"];
// Live ACL of all three before the migration (read 2026-11-09); CREATE OR REPLACE keeps it.
const ACL = "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}";

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};
async function readAs(id, sql) {
  await c.query("savepoint r");
  try {
    await c.query("set local role authenticated");
    await q(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
      JSON.stringify({ sub: id, role: "authenticated", aud: "authenticated" }),
      id,
    ]);
    return (await q(sql))[0];
  } finally {
    await c.query("rollback to savepoint r");
  }
}
const VIEW = `select (select count(*) from public.jobs)::int as jobs, (select count(*) from public.bookings)::int as bookings,
  (select count(*) from public.customers)::int as customers, (select count(*) from public.dumpsters)::int as dumpsters,
  (select count(*) from public.trucks)::int as trucks, (select count(*) from public.job_photos)::int as photos,
  (select count(*) from public.notifications_log)::int as notifications,
  (select count(*) from public.drivers where profile_id = auth.uid())::int as own_driver_row`;

await c.connect();
await c.query("begin transaction read only");
try {
  const [m] = await q(`select bool_or(version = $1) as applied, count(*)::int as n from supabase_migrations.schema_migrations`, [VERSION]);
  ok(`${VERSION} is recorded as applied`, m.applied, m);

  for (const [schema, table, name, cmd, roles] of POLICIES) {
    const [p] = await q(`select cmd, roles::text as roles, permissive, qual, with_check from pg_policies where schemaname = $1 and tablename = $2 and policyname = $3`, [schema, table, name]);
    const expr = p ? p.qual ?? p.with_check : "";
    ok(`${name}: exists, ${cmd}, ${roles}, permissive`, !!p && p.cmd === cmd && p.roles === roles && p.permissive === "PERMISSIVE", p && [p.cmd, p.roles]);
    ok(`${name}: requires d.active (once) next to d.profile_id = auth.uid()`, (expr.match(/d\.active/g) ?? []).length === 1 && expr.includes("(d.profile_id = auth.uid()) AND d.active"));
  }
  const [own] = await q(`select qual from pg_policies where schemaname = 'public' and tablename = 'drivers' and policyname = 'drivers: driver reads own record'`);
  ok("drivers: driver reads own record is unchanged (no active check)", own?.qual === "(profile_id = auth.uid())", own?.qual);
  const [nPol] = await q(`select count(*)::int as n from pg_policies where (schemaname, tablename) in (('public','drivers'),('public','jobs'),('public','bookings'),('public','customers'),('public','dumpsters'),('public','job_photos'),('public','trucks'),('public','notifications_log'))`);
  ok("policy count on the driver tables unchanged (19)", nPol.n === 19, nPol.n);

  for (const sig of FUNCTIONS) {
    const [f] = await q(`select prosrc, prosecdef, proconfig::text as config, pg_get_userbyid(proowner) as owner, proacl::text as acl from pg_proc where oid = to_regprocedure($1)`, [sig]);
    ok(`${sig}: requires d.active (once)`, !!f && (f.prosrc.match(/d\.active/g) ?? []).length === 1 && /d\.profile_id = auth\.uid\(\)\s+and d\.active/.test(f.prosrc));
    ok(`${sig}: security definer, search_path=public, owner postgres`, !!f && f.prosecdef && f.config === "{search_path=public}" && f.owner === "postgres", f && [f.prosecdef, f.config, f.owner]);
    ok(`${sig}: grants unchanged`, f?.acl === ACL, f?.acl);
  }

  console.log("-- what real accounts can read (role authenticated, read only)");
  const drivers = await q(`select profile_id::text as p, id::text as d, active from public.drivers order by active desc, id`);
  const marcusRow = drivers.find((d) => d.p === MARCUS);
  const [marcusJobs] = await q(`select count(*)::int as n from public.jobs where driver_id = $1`, [marcusRow?.d]);
  const marcus = await readAs(MARCUS, VIEW);
  ok("Marcus (active) still reads every job assigned to his driver row", !!marcusRow?.active && marcus.jobs === marcusJobs.n && marcus.own_driver_row === 1, marcus);
  const larry = await readAs(LARRY, VIEW);
  const [all] = await q(`select (select count(*) from public.jobs)::int as jobs, (select count(*) from public.notifications_log)::int as notifications`);
  ok("Larry (owner) still reads every job and notification", larry.jobs === all.jobs && larry.notifications === all.notifications, larry);
  for (const d of drivers.filter((r) => !r.active)) {
    const [{ role }] = await q(`select role::text as role from public.profiles where id = $1`, [d.p]);
    if (role === "owner" || role === "staff") {
      console.log(`   inactive driver row ${d.d.slice(0, 8)} belongs to ${role}: staff policies apply, skipped`);
      continue;
    }
    const v = await readAs(d.p, VIEW);
    ok(
      `inactive driver ${d.d.slice(0, 8)}: reads nothing through driver policies, still reads own drivers row`,
      v.jobs + v.bookings + v.customers + v.dumpsters + v.trucks + v.photos + v.notifications === 0 && v.own_driver_row === 1,
      v,
    );
  }
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED (read only)` : "\nALL PASS (read only)");
process.exit(failures ? 1 : 0);
