// Read-only check that 20261110000000_call_transcript_purge is applied as written.
//
//   node --use-system-ca scripts/check-quo-purge-applied.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Runs in a READ ONLY transaction and writes nothing. Prints counts and
// pass/fail only, never call text.
import fs from "node:fs";
import pg from "pg";

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
  const hist = (await q(`select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261110000000'`))[0].n;
  ok("20261110000000 is in the migration history", hist === 1);
  const col = (await q(`select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_purged_at'`))[0];
  ok("transcript_purged_at: nullable timestamptz", col?.data_type === "timestamp with time zone" && col?.is_nullable === "YES", col);
  for (const sig of ["public.purge_call_transcripts(integer)", "public.ingest_quo_call_event(text,text,jsonb)"]) {
    const a = (await q(`select p.prosecdef as definer, p.proconfig::text as config, p.proacl::text as acl, p.prosrc as src,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
      from pg_proc p where p.oid = to_regprocedure($1)`, [sig]))[0];
    const name = sig.split("(")[0].replace("public.", "");
    ok(`${name} exists, INVOKER, search_path=public`, a && !a.definer && a.config === "{search_path=public}", a && { definer: a.definer, config: a.config });
    ok(`${name} EXECUTE: service_role only`, a && a.svc && !a.auth && !a.anon, a && a.acl);
    if (name === "purge_call_transcripts") ok("purge refuses under 30 days", /p_days < 30/.test(a?.src ?? ""));
    if (name === "ingest_quo_call_event")
      ok("ingest has the 3 purge guards", ((a?.src ?? "").match(/when t\.transcript_purged_at is not null then null/g) ?? []).length === 3);
  }
  const counts = (await q(`select count(*)::int as rows, count(transcript_purged_at)::int as purged from public.call_transcripts`))[0];
  console.log(`   call_transcripts: ${counts.rows} rows, ${counts.purged} purged`);
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
