-- =============================================================================
-- Crazy Larry's Dumpsters — tables private by default, RLS enforced, existing
-- tables locked down
-- =============================================================================
-- Same bug class as 20260923000000 / 20260924000000, at the table layer.
-- Supabase's default privileges gave anon + authenticated EVERY privilege
-- (arwdDxtm, incl. TRUNCATE, which RLS does not govern) on every table and
-- sequence created in public, so the only thing between the public anon key
-- and a table was "someone remembered to enable RLS". Three layers, so no
-- single one is the only safeguard:
--
--   1. New tables/views/sequences get NO grants to anon/authenticated until a
--      migration grants them explicitly (tables have no built-in PUBLIC grant,
--      so the per-schema form is sufficient here — unlike functions).
--   2. An event trigger enables RLS on every new table in public, and sets
--      security_invoker on every new view (a view otherwise runs with its
--      owner's rights and bypasses RLS). Failures WARN rather than abort, so it
--      can never block a migration; layer 1 still denies and the schema guard
--      test (lib/db/schema-guard.integration.test.ts) catches it.
--   3. Existing tables: anon loses everything (no policy grants anon a single
--      row — every non-staff policy is keyed on auth.uid(); verified zero rows
--      visible to anon on all 19 tables), authenticated loses TRUNCATE /
--      REFERENCES / TRIGGER (never used through the API). authenticated keeps
--      SELECT/INSERT/UPDATE/DELETE, which RLS governs.
--
-- Blast radius (rolled-back dry runs against wbhwfnxphqnxiphnbcyq, 2026-09-24):
-- existing tables' grants + RLS unchanged by layers 1-2; authenticated CRUD
-- grants unchanged by layer 3; a real staff session still reads all bookings;
-- anon table reads now return 42501 instead of []. No app code reads a public
-- table without a session (public routes use the service-role client; no
-- Realtime; driver photos are Storage, a different schema). Functions,
-- auth/storage schemas, service_role and the dashboard (postgres) unaffected.
--
-- RULES FOR FUTURE MIGRATIONS:
--   * New table: RLS is now automatic, but add policies AND
--       grant select, insert, update, delete on public.<t> to authenticated;
--     Grant to anon only for a table that genuinely needs public access.
--   * New view: security_invoker is automatic; grant it like a table.
--   * New sequence / serial / identity column users insert through:
--       grant usage on sequence public.<s> to authenticated;
--   * Materialized views cannot be security_invoker and bypass RLS — the
--     trigger warns; don't expose them to anon/authenticated.
-- =============================================================================

-- ---------------------------------------------------------------- layer 1
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------- layer 2
-- Runs as the role doing the DDL (not SECURITY DEFINER — it only ever alters
-- objects that role just created). Private by default under 20260924000000;
-- event triggers don't need EXECUTE grants to fire.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  r record;
begin
  for r in
    select * from pg_event_trigger_ddl_commands()
    where schema_name = 'public'
      and object_type in ('table', 'table partition', 'view', 'materialized view')
  loop
    begin
      if r.object_type in ('table', 'table partition') then
        execute format('alter table %s enable row level security', r.object_identity);
      elsif r.object_type = 'view' then
        execute format('alter view %s set (security_invoker = true)', r.object_identity);
      else
        raise warning 'rls_auto_enable: % is a materialized view — it bypasses RLS; do not grant it to anon/authenticated',
          r.object_identity;
      end if;
    exception when others then
      raise warning 'rls_auto_enable: could not secure % (%): %',
        r.object_identity, r.object_type, sqlerrm;
    end;
  end loop;
end;
$$;

comment on function public.rls_auto_enable() is
  'Event trigger: enables RLS on every new public table and security_invoker on every new public view. See migration 20260924010000.';

drop event trigger if exists rls_auto_enable;
create event trigger rls_auto_enable
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE VIEW', 'CREATE MATERIALIZED VIEW')
  execute function public.rls_auto_enable();

-- ---------------------------------------------------------------- layer 3
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
