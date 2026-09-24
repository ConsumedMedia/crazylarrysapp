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
