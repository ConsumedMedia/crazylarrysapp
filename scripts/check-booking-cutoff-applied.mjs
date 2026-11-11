// Read-only check that 20261111000000_booking_cutoff is applied as written.
//
//   node --use-system-ca scripts/check-booking-cutoff-applied.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Runs in a READ ONLY transaction and writes nothing. Function md5s are the
// ones scripts/probe-booking-cutoff.mjs printed with the migration applied
// inside its rolled-back transaction (2026-11-11), hashed with carriage
// returns removed so a migration pushed from a CRLF checkout still matches.
import fs from "node:fs";
import pg from "pg";

const SERVICE_ONLY = "{postgres=X/postgres,service_role=X/postgres}";
const EXPECTED = {
  // rebuilt: same signature and ACL as before the migration
  "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)": ["5caa6553fb3482439a75926ed8ab764a", SERVICE_ONLY],
  "public.staff_create_pay_link_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid,text)": [
    "80858bcbc28557d89113eb5aa7d586ee",
    "{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}",
  ],
  // new
  "public.booking_delivery_floor(timestamp with time zone)": ["d1db7a65014955af275efaefe8d26a5c", SERVICE_ONLY],
  "public._booking_clock()": ["71bc3cb78f2b49a4378feea35fdaad45", "{postgres=X/postgres}"],
  "public._assert_online_delivery_floor(date)": ["8f7ad54435eea39a5ac4a4e60c9b00e4", "{postgres=X/postgres}"],
  "public._stamp_booking_settings()": ["5da663bea5116945a6c327815bfe5bb9", "{postgres=X/postgres}"],
  // untouched
  "public._create_booking_core(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid,text,uuid,uuid)": ["e8245ce0504d55f53bad223cba209d60", SERVICE_ONLY],
  "public.staff_create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,boolean,uuid)": [
    "f646b99e9ce92916d11d919e7abdc7b6",
    "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  ],
  "public.size_availability(dumpster_size,date,date,integer)": [
    "b553ad0b46deee561956bd203835250c",
    "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}",
  ],
};

const url = fs.readFileSync(".env.local", "utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await c.query(sql, params)).rows;
let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
  if (!cond) failures++;
};

await c.connect();
await c.query("begin read only");
try {
  ok("20261111000000 is in the migration history",
    (await q(`select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261111000000'`))[0].n === 1);
  const t = (await q(`select to_regclass('public.cl_booking_settings') as t`))[0].t;
  ok("cl_booking_settings exists", t !== null);
  if (t !== null) {
    const p = (await q(`select c.relrowsecurity as rls,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
        has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ins,
        has_table_privilege('authenticated', c.oid, 'DELETE') as auth_del,
        has_column_privilege('authenticated', c.oid, 'cutoff_enabled', 'UPDATE') as upd_enabled,
        has_column_privilege('authenticated', c.oid, 'cutoff_time', 'UPDATE') as upd_time,
        has_column_privilege('authenticated', c.oid, 'updated_by', 'UPDATE') as upd_by
      from pg_class c where c.oid = 'public.cl_booking_settings'::regclass`))[0];
    ok("RLS on; anon nothing; authenticated reads and updates the two setting columns only",
      p.rls && !p.anon_sel && p.auth_sel && !p.auth_ins && !p.auth_del && p.upd_enabled && p.upd_time && !p.upd_by, p);
    const pols = (await q(`select polname, polcmd, pg_get_expr(polqual, polrelid) as u, pg_get_expr(polwithcheck, polrelid) as w
        from pg_policy where polrelid = 'public.cl_booking_settings'::regclass order by polname`)).map((x) => `${x.polname}|${x.polcmd}|${x.u}|${x.w}`);
    ok("policies: owner update, staff read", JSON.stringify(pols) === JSON.stringify([
      "cl_booking_settings: owner update|w|is_owner()|is_owner()",
      "cl_booking_settings: staff read|r|is_staff()|null",
    ]), pols);
    const con = (await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'cl_booking_settings_cutoff_time_check'`))[0]?.d ?? "";
    ok("cutoff time check: 03:00–23:45, whole minutes, 15-minute steps", /03:00/.test(con) && /23:45/.test(con) && /% 15/.test(con), con);
    const row = (await q(`select count(*)::int as n, bool_and(cutoff_enabled) as on_, max(cutoff_time)::text as t from public.cl_booking_settings`))[0];
    console.log(`   setting now: ${row.n} row, cutoff ${row.on_ ? "ON" : "off"} at ${row.t}`);
    ok("exactly one settings row", row.n === 1);
  }
  for (const [sig, [md5, acl]] of Object.entries(EXPECTED)) {
    const f = (await q(`select md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5, p.proacl::text as acl, p.proconfig::text as cfg
        from pg_proc p where p.oid = to_regprocedure($1)`, [sig]))[0];
    const n = sig.split("(")[0].replace("public.", "");
    ok(`${n}: definition as probed, ACL ${acl}`, f?.md5 === md5 && f?.acl === acl && f?.cfg === "{search_path=public}", f && { md5: f.md5, acl: f.acl });
  }
  if (t !== null) {
    const f = (await q(`select earliest_online::text as online, earliest_staff::text as staff, after_cutoff as after from public.booking_delivery_floor()`))[0];
    console.log(`   floor right now: online ${f.online}, staff ${f.staff}, after cutoff ${f.after}`);
  }
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
