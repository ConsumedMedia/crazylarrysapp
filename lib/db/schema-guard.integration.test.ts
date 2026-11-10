/**
 * Schema security guard — asserts the invariants that stop the "anon key can
 * reach it" bug class, against the linked Supabase project's catalogs.
 *
 * Read-only (catalog SELECTs over DATABASE_URL, the same pg connection the
 * QuickBooks token manager uses). Gated like the other DB tests:
 *   CL_RUN_DB_TESTS=1 npx vitest run lib/db/schema-guard.integration.test.ts
 *
 * Background: migrations 20260923000000 (seven service-only SECURITY DEFINER
 * functions were anon-callable), 20260924000000 (functions private by
 * default), 20260924010000 (tables private by default + RLS auto-enable +
 * existing tables locked down). This test catches drift from ANY source —
 * a migration that forgets a revoke, a table made in the dashboard, a
 * disabled event trigger.
 *
 * If it fails because you intentionally added something: grant it
 * deliberately in a migration and, for a new anon-callable SECURITY DEFINER
 * function, add it to ANON_DEFINER_ALLOWLIST with the reason.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

const RUN = process.env.CL_RUN_DB_TESTS === "1";

/**
 * SECURITY DEFINER functions anon may execute, reviewed 2026-09-24. Each is
 * either guarded internally (is_staff/is_owner -> anon is rejected in-body),
 * public by design, an RLS helper returning only a boolean, or a trigger
 * function (not callable via RPC).
 */
const ANON_DEFINER_ALLOWLIST = new Set([
  // public by design
  "booking_quote(dumpster_size)",
  "size_availability(dumpster_size,date,date,integer)",
  "claim_guest_bookings()", // acts only on auth.uid()'s verified email; no-op for anon
  // RLS / role helpers (boolean or caller's own role)
  "is_owner()",
  "is_staff()",
  "current_user_role()",
  "driver_can_see_customer(uuid)",
  "driver_can_see_dumpster(uuid)",
  // trigger functions
  "handle_new_user()",
  "log_dumpster_created()",
  // is_staff()-guarded in body
  "set_dumpster_status(uuid,dumpster_status)",
  "set_booking_status(uuid,booking_status)",
  "check_job_assignment(uuid,uuid)",
  "clear_unit(uuid)",
  "assign_unit(uuid,uuid)",
  "unassign_job(uuid)",
  "assign_job(uuid,uuid,uuid,boolean)",
  "set_route_order(uuid,date,uuid[])",
  "confirm_job_tags(uuid,text[])",
  "complete_job(uuid)",
  "quickbooks_status()",
  "notification_health()",
]);

describe.skipIf(!RUN)("schema security guard (anon-key exposure invariants)", () => {
  let pool: Pool;
  const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
    (await pool.query(sql)).rows as T[];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 1,
    });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("every public table has row level security enabled", async () => {
    const rows = await q<{ relname: string }>(
      `select relname from pg_class
       where relnamespace = 'public'::regnamespace and relkind in ('r','p') and not relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("anon has no privileges on any public table, view or sequence", async () => {
    const rows = await q<{ obj: string; privs: string }>(
      `select c.relname as obj, string_agg(a.privilege_type, ',') as privs
       from pg_class c, aclexplode(c.relacl) a
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','S')
         and a.grantee = 'anon'::regrole
       group by 1 order by 1`,
    );
    expect(rows).toEqual([]);
  });

  it("authenticated has no TRUNCATE / REFERENCES / TRIGGER on public tables", async () => {
    const rows = await q<{ obj: string; priv: string }>(
      `select c.relname as obj, a.privilege_type as priv
       from pg_class c, aclexplode(c.relacl) a
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m')
         and a.grantee = 'authenticated'::regrole
         and a.privilege_type in ('TRUNCATE','REFERENCES','TRIGGER')`,
    );
    expect(rows).toEqual([]);
  });

  it("every public view is security_invoker", async () => {
    const rows = await q<{ relname: string }>(
      `select relname from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'v'
         and not coalesce('security_invoker=true' = any(reloptions) or 'security_invoker=on' = any(reloptions), false)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("default privileges for postgres: nothing auto-granted to PUBLIC/anon/authenticated", async () => {
    const rows = await q<{ scope: string; type: string; acl: string }>(
      `select coalesce(nullif(defaclnamespace, 0)::regnamespace::text, '<global>') as scope,
              defaclobjtype::text as type, defaclacl::text as acl
       from pg_default_acl
       where defaclrole = 'postgres'::regrole and defaclnamespace in (0, 'public'::regnamespace)
       order by 1, 2`,
    );
    console.log("postgres default ACLs:", JSON.stringify(rows));
    const byKey = new Map(rows.map((r) => [`${r.scope}:${r.type}`, r.acl]));
    // functions: the global row must exist (it's what removes PUBLIC)
    expect(byKey.get("<global>:f")).toBeDefined();
    for (const r of rows) {
      expect(r.acl, `${r.scope}:${r.type}`).not.toMatch(/(^\{|,)=/); // PUBLIC entry
      expect(r.acl, `${r.scope}:${r.type}`).not.toMatch(/\banon=/);
      expect(r.acl, `${r.scope}:${r.type}`).not.toMatch(/\bauthenticated=/);
    }
    for (const t of ["f", "r", "S"]) expect(byKey.has(`public:${t}`), `public:${t}`).toBe(true);
  });

  it("rls_auto_enable event trigger exists and is enabled", async () => {
    const rows = await q<{ evtenabled: string; evtevent: string }>(
      `select evtenabled, evtevent from pg_event_trigger where evtname = 'rls_auto_enable'`,
    );
    expect(rows).toEqual([{ evtenabled: "O", evtevent: "ddl_command_end" }]);
  });

  it("call-log functions (webhook writer, purge, redaction and segment helpers) are INVOKER and callable by service_role only", async () => {
    // Matched by NAME, so every overload is covered whatever its arguments
    // (20261110010000 replaced the 3-argument ingest with a 4-argument one).
    const rows = await q<{ fn: string; definer: boolean; anon_x: boolean; auth_x: boolean; svc_x: boolean }>(
      `select p.oid::regprocedure::text as fn, p.prosecdef as definer,
              has_function_privilege('anon', p.oid, 'execute') as anon_x,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
              has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('ingest_quo_call_event', 'purge_call_transcripts', '_redact_card_numbers',
                           '_quo_segment', '_quo_merge_segments')
       order by 1`,
    );
    // Before 20261028000000 is applied there is nothing to check.
    for (const r of rows) {
      expect({ fn: r.fn, definer: r.definer, anon_x: r.anon_x, auth_x: r.auth_x, svc_x: r.svc_x }).toEqual({
        fn: r.fn,
        definer: false,
        anon_x: false,
        auth_x: false,
        svc_x: true,
      });
    }
    // Two overloads would make the webhook's 3-argument call ambiguous.
    expect(rows.filter((r) => r.fn.startsWith("ingest_quo_call_event(")).length).toBeLessThanOrEqual(1);
  });

  it("pay-link tables: staff read through RLS only; the lookup counter has no API access", async () => {
    const rows = await q<{ t: string; rls: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
      `select c.relname as t, c.relrowsecurity as rls,
              has_any_column_privilege('authenticated', c.oid, 'SELECT') as sel,
              has_table_privilege('authenticated', c.oid, 'INSERT') as ins,
              has_table_privilege('authenticated', c.oid, 'UPDATE') as upd,
              has_table_privilege('authenticated', c.oid, 'DELETE') as del
       from pg_class c
       where c.relnamespace = 'public'::regnamespace
         and c.relname in ('cl_pay_link_settings','pay_links','pay_link_events','consent_records','pay_link_lookup_attempts')
       order by 1`,
    );
    // Before migration 20261103000000 is applied there is nothing to check.
    if (rows.length === 0) return;
    expect(rows).toEqual([
      { t: "cl_pay_link_settings", rls: true, sel: true, ins: false, upd: true, del: false },
      { t: "consent_records", rls: true, sel: true, ins: false, upd: false, del: false },
      { t: "pay_link_events", rls: true, sel: true, ins: false, upd: false, del: false },
      { t: "pay_link_lookup_attempts", rls: true, sel: false, ins: false, upd: false, del: false },
      { t: "pay_links", rls: true, sel: true, ins: false, upd: false, del: false },
    ]);
  });

  it("pay_links.token_encrypted (once it exists) is readable by service_role only", async () => {
    const rows = await q<{ auth_x: boolean; anon_x: boolean; svc_x: boolean }>(
      `select has_column_privilege('authenticated', 'public.pay_links', 'token_encrypted', 'SELECT') as auth_x,
              has_column_privilege('anon', 'public.pay_links', 'token_encrypted', 'SELECT') as anon_x,
              has_column_privilege('service_role', 'public.pay_links', 'token_encrypted', 'SELECT') as svc_x
       from information_schema.columns
       where table_schema = 'public' and table_name = 'pay_links' and column_name = 'token_encrypted'`,
    );
    // Before migration 20261103010000 is applied there is nothing to check.
    for (const r of rows) expect(r).toEqual({ auth_x: false, anon_x: false, svc_x: true });
  });

  it("pay-link functions: staff RPCs for authenticated, the public page's RPCs for service_role only", async () => {
    const rows = await q<{ fn: string; auth_x: boolean; svc_x: boolean }>(
      `select p.oid::regprocedure::text as fn,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
              has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like '%pay_link%' or p.proname = 'resolve_payment_attempt')
       order by 1`,
    );
    if (rows.length === 0) return;
    const STAFF = new Set(["issue_pay_link", "staff_create_pay_link_booking", "resolve_payment_attempt", "pay_link_live_counts"]);
    for (const r of rows) {
      const name = r.fn.split("(")[0];
      expect(r.auth_x, r.fn).toBe(STAFF.has(name));
      if (!name.startsWith("_") && !["end_pay_links_on_booking_change", "validate_pay_link_settings", "clear_pay_link_token"].includes(name)) {
        expect(r.svc_x, r.fn).toBe(true);
      }
    }
  });

  it("driver access requires drivers.active (every policy and helper that matches a driver by auth.uid())", async () => {
    // Before migration 20261109010000 is applied there is nothing to check.
    const [applied] = await q<{ n: number }>(
      `select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261109010000'`,
    );
    if (applied.n === 0) return;
    // Any policy outside the drivers table that joins drivers on the caller
    // must also require d.active. "drivers: driver reads own record" is left
    // without it on purpose (the inactive banner needs that row).
    const policies = await q<{ name: string; expr: string }>(
      `select schemaname || '.' || tablename || ': ' || policyname as name, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
       from pg_policies
       where not (schemaname = 'public' and tablename = 'drivers')
         and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'drivers d'
       order by 1`,
    );
    expect(policies.length).toBeGreaterThanOrEqual(7);
    for (const p of policies) expect(p.expr, p.name).toContain("(d.profile_id = auth.uid()) AND d.active");
    // Helpers and RPCs that let a driver through on d.profile_id = auth.uid().
    const fns = await q<{ fn: string; src: string }>(
      `select p.oid::regprocedure::text as fn, p.prosrc as src from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosrc ~ 'd\\.profile_id = auth\\.uid\\(\\)'
       order by 1`,
    );
    expect(fns.map((f) => f.fn)).toEqual(
      expect.arrayContaining(["complete_job(uuid)", "driver_can_see_customer(uuid)", "driver_can_see_dumpster(uuid)"]),
    );
    for (const f of fns) expect(f.src, f.fn).toMatch(/d\.profile_id = auth\.uid\(\)\s+and d\.active/);
  });

  it("no un-reviewed SECURITY DEFINER function is executable by anon", async () => {
    const rows = await q<{ fn: string }>(
      `select p.oid::regprocedure::text as fn from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and has_function_privilege('anon', p.oid, 'execute')
       order by 1`,
    );
    const unreviewed = rows.map((r) => r.fn).filter((fn) => !ANON_DEFINER_ALLOWLIST.has(fn));
    expect(unreviewed).toEqual([]);
  });
});
