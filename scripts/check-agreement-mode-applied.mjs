// Read-only check that 20261117000000_agreement_mode is applied as written.
//
//   node --use-system-ca scripts/check-agreement-mode-applied.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Runs in a READ ONLY transaction and writes nothing. Function md5s are the
// ones scripts/probe-agreement-mode.mjs printed with the migration applied
// inside its rolled-back transaction (2026-11-18), hashed with carriage
// returns removed so a migration pushed from a CRLF checkout still matches.
import fs from "node:fs";
import pg from "pg";

const SERVICE_ONLY = "{postgres=X/postgres,service_role=X/postgres}";
const EXPECTED = {
  // new
  "public.booking_agreement_mode()": ["bb4df0124bd9709fa07ca935827f98bf", SERVICE_ONLY],
  "public._stamp_agreement_settings()": ["be742136a0140954568be5f3ce0e9d51", "{postgres=X/postgres}"],
  // untouched by this migration
  "public._stamp_booking_settings()": ["5da663bea5116945a6c327815bfe5bb9", "{postgres=X/postgres}"],
  "public.booking_delivery_floor(timestamp with time zone)": ["d1db7a65014955af275efaefe8d26a5c", SERVICE_ONLY],
  "public.create_booking(dumpster_size,date,text,text,integer,text,text,text,text,text,uuid,boolean,uuid)": ["5caa6553fb3482439a75926ed8ab764a", SERVICE_ONLY],
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
  ok("20261117000000 is in the migration history",
    (await q(`select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261117000000'`))[0].n === 1);
  const t = (await q(`select to_regclass('public.cl_agreement_settings') as t`))[0].t;
  ok("cl_agreement_settings exists", t !== null);
  if (t !== null) {
    const p = (await q(`select c.relrowsecurity as rls,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
        has_table_privilege('anon', c.oid, 'UPDATE') as anon_upd,
        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
        has_table_privilege('authenticated', c.oid, 'INSERT') as auth_ins,
        has_table_privilege('authenticated', c.oid, 'DELETE') as auth_del,
        has_column_privilege('authenticated', c.oid, 'mode', 'UPDATE') as upd_mode,
        has_column_privilege('authenticated', c.oid, 'updated_by', 'UPDATE') as upd_by,
        has_column_privilege('authenticated', c.oid, 'id', 'UPDATE') as upd_id
      from pg_class c where c.oid = 'public.cl_agreement_settings'::regclass`))[0];
    ok("RLS on; anon nothing; authenticated reads and updates mode only",
      p.rls && !p.anon_sel && !p.anon_upd && p.auth_sel && !p.auth_ins && !p.auth_del && p.upd_mode && !p.upd_by && !p.upd_id, p);
    const pols = (await q(`select polname, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as u, pg_get_expr(polwithcheck, polrelid) as w
        from pg_policy where polrelid = 'public.cl_agreement_settings'::regclass order by polname`)).map((x) => `${x.polname}|${x.cmd}|${x.u}|${x.w}`);
    ok("policies: owner update, staff read", JSON.stringify(pols) === JSON.stringify([
      "cl_agreement_settings: owner update|w|is_owner()|is_owner()",
      "cl_agreement_settings: staff read|r|is_staff()|null",
    ]), pols);
    const con = (await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'cl_agreement_settings_mode_check'`))[0]?.d ?? "";
    ok("mode check: attest or docusign only", /'attest'/.test(con) && /'docusign'/.test(con), con);
    const trg = (await q(`select count(*)::int as n from pg_trigger where tgrelid = 'public.cl_agreement_settings'::regclass and not tgisinternal
        and tgname in ('cl_agreement_settings_set_updated_at', 'cl_agreement_settings_stamp')`))[0].n;
    ok("both triggers present", trg === 2, trg);
    const row = (await q(`select count(*)::int as n, max(mode) as m from public.cl_agreement_settings`))[0];
    console.log(`   mode now: ${row.m} (${row.n} row)`);
    ok("exactly one settings row", row.n === 1);
  }
  for (const [sig, [md5, acl]] of Object.entries(EXPECTED)) {
    const f = (await q(`select md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5, p.proacl::text as acl, p.proconfig::text as cfg
        from pg_proc p where p.oid = to_regprocedure($1)`, [sig]))[0];
    const n = sig.split("(")[0].replace("public.", "");
    ok(`${n}: definition as probed, ACL ${acl}`, f?.md5 === md5 && f?.acl === acl && f?.cfg === "{search_path=public}", f && { md5: f.md5, acl: f.acl });
  }
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
