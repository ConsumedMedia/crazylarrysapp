// Read-only check that 20261110010000_quo_transcript_segments is applied as written.
//
//   node --use-system-ca scripts/check-quo-segments-applied.mjs     (repo root; reads DATABASE_URL from .env.local)
//
// Runs in a READ ONLY transaction and writes nothing. Function md5s are the
// ones scripts/probe-quo-segments.mjs printed with the migration applied
// inside its rolled-back transaction (2026-11-10). Prints counts and
// pass/fail only, never call text.
import fs from "node:fs";
import pg from "pg";

const EXPECTED = {
  "public.ingest_quo_call_event(text,text,jsonb,text)": "e423d118f3833f2032c360d8fcf2186e",
  "public.purge_call_transcripts(integer)": "94a08435dd3a923eeb2c7e4bb2980878",
  "public._redact_card_numbers(text)": "d0da50a983c654a2dab421addc255a9d",
  "public._quo_segment(jsonb,boolean)": "76b065631a80d45cb927a2a5653fc8e6",
  "public._quo_merge_segments(jsonb)": "240c811482e564083df1c8b8eb5b7174",
};
const SERVICE_ONLY_ACL = "{postgres=X/postgres,service_role=X/postgres}";

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
  const hist = (await q(`select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261110010000'`))[0].n;
  ok("20261110010000 is in the migration history", hist === 1);
  const col = (await q(`select data_type, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'call_transcripts' and column_name = 'transcript_segments'`))[0];
  ok("transcript_segments: nullable jsonb", col?.data_type === "jsonb" && col?.is_nullable === "YES", col);
  ok("3-argument ingest is gone", (await q(`select to_regprocedure('public.ingest_quo_call_event(text,text,jsonb)') is null as g`))[0].g);
  ok("exactly one ingest_quo_call_event",
    (await q(`select count(*)::int as n from pg_proc where proname = 'ingest_quo_call_event' and pronamespace = 'public'::regnamespace`))[0].n === 1);
  for (const [sig, md5] of Object.entries(EXPECTED)) {
    const a = (await q(`select md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5, p.prosecdef as definer, p.proconfig::text as config, p.proacl::text as acl
        from pg_proc p where p.oid = to_regprocedure($1)`, [sig]))[0];
    const name = sig.split("(")[0].replace("public.", "");
    ok(`${name}: definition as probed`, a?.md5 === md5, a?.md5);
    ok(`${name}: INVOKER, search_path=public, service_role only`,
      a && !a.definer && a.config === "{search_path=public}" && a.acl === SERVICE_ONLY_ACL, a && { definer: a.definer, acl: a.acl });
  }
  const counts = (await q(`select count(*)::int as rows, count(transcript_segments)::int as with_segments,
      count(transcript_purged_at)::int as purged from public.call_transcripts`))[0];
  console.log(`   call_transcripts: ${counts.rows} rows, ${counts.with_segments} with segments, ${counts.purged} purged`);
  ok("no row has segments yet (nothing writes them until a flag is on)", counts.with_segments === 0, counts.with_segments);
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
