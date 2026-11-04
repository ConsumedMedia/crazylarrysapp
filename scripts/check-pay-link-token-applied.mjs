// Read-only check of the APPLIED 20261103010000_pay_link_token_encrypted migration.
//
//   node scripts/check-pay-link-token-applied.mjs   (repo root; reads DATABASE_URL from .env.local)
//
// One READ ONLY transaction, rolled back. It switches role to authenticated
// and anon (no user, no JWT) only to prove they can't SELECT the column; no
// function that writes is called and nothing is decrypted.
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
async function readAs(role, sql) {
  await c.query("savepoint r");
  try {
    await c.query(`set local role ${role}`);
    const rows = (await c.query(sql)).rows;
    await c.query("rollback to savepoint r");
    return { ok: true, rows };
  } catch (e) {
    await c.query("rollback to savepoint r");
    return { ok: false, code: e.code };
  }
}

await c.connect();
await c.query("begin transaction read only");
try {
  const [m] = await q(`select bool_or(version = '20261103010000') as applied, count(*)::int as n from supabase_migrations.schema_migrations`);
  ok("20261103010000 is recorded as applied", m.applied, m);

  const [col] = await q(`select is_nullable, data_type,
      has_column_privilege('authenticated', 'public.pay_links', 'token_encrypted', 'SELECT') as authenticated,
      has_column_privilege('anon', 'public.pay_links', 'token_encrypted', 'SELECT') as anon,
      has_column_privilege('service_role', 'public.pay_links', 'token_encrypted', 'SELECT') as service_role
    from information_schema.columns where table_schema = 'public' and table_name = 'pay_links' and column_name = 'token_encrypted'`);
  ok("token_encrypted exists, nullable bytea", col?.is_nullable === "YES" && col.data_type === "bytea", col ?? "missing");
  ok("column privilege: service_role only", !!col && col.service_role && !col.authenticated && !col.anon, col);

  const staff = await readAs("authenticated", "select token_encrypted from public.pay_links limit 1");
  ok("as authenticated (any staff session): select token_encrypted -> 42501", !staff.ok && staff.code === "42501", staff.code ?? "allowed");
  const star = await readAs("authenticated", "select * from public.pay_links limit 1");
  ok("as authenticated: select * -> 42501", !star.ok && star.code === "42501", star.code ?? "allowed");
  const anon = await readAs("anon", "select token_encrypted from public.pay_links limit 1");
  ok("as anon: select token_encrypted -> 42501", !anon.ok && anon.code === "42501", anon.code ?? "allowed");
  const named = await readAs("authenticated", "select id, status, paid_at from public.pay_links limit 1");
  ok("as authenticated: other columns by name are allowed (RLS then filters rows)", named.ok, named.code ?? "ok");
  // Must match PAY_LINK_STAFF_COLUMNS in lib/pay-links/booking-state.ts (the booking page's read).
  const panel = await readAs(
    "authenticated",
    "select id, status, created_by, created_at, ended_at, ended_reason, agreement_ack_at, charge_started_at, paid_at from public.pay_links limit 1",
  );
  ok("as authenticated: the booking page's exact column list is allowed", panel.ok, panel.code ?? "ok");

  const [cons] = await q(`select count(*)::int as n from pg_constraint where conname = 'pay_links_token_only_while_active' and conrelid = 'public.pay_links'::regclass`);
  ok("check constraint: a stored copy only on an active link", cons.n === 1);
  const [tg] = await q(`select tgenabled from pg_trigger where tgname = 'pay_links_clear_token' and tgrelid = 'public.pay_links'::regclass`);
  ok("trigger pay_links_clear_token exists and is enabled", tg?.tgenabled === "O", tg ?? "missing");

  const fns = await q(`select p.oid::regprocedure::text as sig,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
    from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname in ('issue_pay_link', '_issue_pay_link', 'staff_create_pay_link_booking', 'pay_link_reminder_token', 'pay_link_live_counts')
    order by 1`);
  const by = Object.fromEntries(fns.map((f) => [f.sig.split("(")[0], f]));
  ok("exactly one signature each (old ones dropped)", fns.length === 5, fns.map((f) => f.sig));
  ok("issue_pay_link(uuid,text), staff_create_pay_link_booking(...,text), pay_link_live_counts: authenticated, not anon",
    ["issue_pay_link", "staff_create_pay_link_booking", "pay_link_live_counts"].every((n) => by[n]?.auth && !by[n]?.anon));
  ok("pay_link_reminder_token: service_role only", by.pay_link_reminder_token?.svc && !by.pay_link_reminder_token?.auth && !by.pay_link_reminder_token?.anon);
  ok("_issue_pay_link: neither anon nor authenticated", !!by._issue_pay_link && !by._issue_pay_link.auth && !by._issue_pay_link.anon);

  const [n] = await q(`select count(*)::int as live, count(*) filter (where token_encrypted is not null)::int as stored,
      (select count(*)::int from public.pay_links where status <> 'active' and token_encrypted is not null) as stored_on_dead
    from public.pay_links where status = 'active'`);
  ok("no stored copy on any dead link", n.stored_on_dead === 0, n);
} finally {
  await c.query("rollback");
  await c.end();
}
console.log(failures ? `\n${failures} FAILED (read only)` : "\nALL PASS (read only)");
process.exit(failures ? 1 : 0);
