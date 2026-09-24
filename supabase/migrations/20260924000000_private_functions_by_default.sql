-- =============================================================================
-- Crazy Larry's Dumpsters — new functions are private by default
-- =============================================================================
-- Root-cause fix for the class of bug closed in 20260923000000: every function
-- created in schema public was automatically executable by PUBLIC, anon and
-- authenticated, so any SECURITY DEFINER function a migration forgot to revoke
-- was callable by anyone holding the public anon key via /rest/v1/rpc/<name>.
--
-- After this migration, a function created by `postgres` (the role every
-- migration runs as) is executable only by its owner and service_role until a
-- migration grants it explicitly.
--
-- Two statements, because the exposure had two independent sources:
--   1. PUBLIC  — Postgres' BUILT-IN default, which is global. Per the Postgres
--      docs a per-schema `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ...
--      FROM PUBLIC` "has no effect"; it must be revoked globally (FOR ROLE,
--      no IN SCHEMA). Supabase's troubleshooting page shows the per-schema
--      form — dry-run 2026-09-24 confirmed it leaves `=X/postgres` (PUBLIC) on
--      new functions and anon still able to execute them.
--   2. anon / authenticated — Supabase's per-schema default-ACL row for
--      functions created by postgres in public.
--
-- Scope / what this does NOT change (all verified by rolled-back dry-run
-- against wbhwfnxphqnxiphnbcyq on 2026-09-24):
--   * Existing functions keep their current ACLs exactly (md5 of every public
--     function's ACL+owner identical before/after) — booking_quote,
--     size_availability, is_staff, etc. are untouched.
--   * CREATE OR REPLACE of an existing function keeps its existing grants.
--   * Triggers still fire for users without EXECUTE on the trigger function.
--   * Tables and sequences keep Supabase's default grants (every public table
--     has RLS enabled; tables are a separate decision).
--   * Functions owned by supabase_admin (btree_gist, and any extension
--     Supabase installs into public later) are unaffected — postgres cannot
--     alter supabase_admin's default privileges.
--
-- RULES FOR FUTURE MIGRATIONS (what now needs an explicit GRANT):
--   * Any new function meant to be called through the API:
--       grant execute on function public.fn(argtypes) to authenticated;  -- and/or anon
--   * Any new helper used inside an RLS policy (like is_staff /
--     driver_can_see_customer): policies run it as the QUERYING role, so
--     without `grant execute ... to authenticated` (and anon, if the policy
--     applies to anon) every query through that policy fails with 42501.
--   * DROP + CREATE (including adding/removing a parameter, which creates a
--     new overload) produces a brand-new, private function — re-grant it.
-- =============================================================================

alter default privileges for role postgres
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
