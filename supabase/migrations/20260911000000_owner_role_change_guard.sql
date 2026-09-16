-- =============================================================================
-- Crazy Larry's Dumpsters — tighten role-change guard for 'owner'
-- =============================================================================
-- Prior behavior (20260901000000): any change to profiles.role required only
-- is_staff() (true for BOTH 'staff' and 'owner'). That meant any regular staff
-- member could, via a direct PostgREST call with their own valid session,
-- promote any profile — including their own — to 'owner'. Nothing in the app
-- UI exposed this, but the DB-level permission existed regardless.
--
-- New behavior: a role change into OR out of 'owner' additionally requires
-- is_owner(). Every other transition (customer<->driver, customer<->staff,
-- staff<->driver, etc.) keeps the existing is_staff() bar — unchanged, so the
-- admin "create user" flow's driver-only path and the existing /drivers page
-- are not affected by this migration.
--
-- Bootstrapping / service-role note: is_owner() reads auth.uid(), which is
-- NULL for a raw Postgres connection (Supabase SQL editor, DATABASE_URL) or a
-- service-role call with no user JWT. `not is_owner()` then evaluates to NULL,
-- and `if NULL then raise` does not raise — so direct DB access continues to
-- bypass this check exactly as it already bypassed the is_staff() check before
-- it (see the Phase 10 seed script, which promotes its throwaway admin to
-- 'owner' via a direct pg connection for this exact reason). No new
-- bootstrapping problem is introduced; behavior for non-interactive/admin
-- tooling is unchanged.
-- =============================================================================

create or replace function public.enforce_profile_role_change()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role then
    if new.role = 'owner' or old.role = 'owner' then
      if not public.is_owner() then
        raise exception 'Only the owner may grant or revoke owner access'
          using errcode = '42501';
      end if;
    elsif not public.is_staff() then
      raise exception 'Only staff or owner may change a profile role'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.enforce_profile_role_change() is
  'Role-change guard on public.profiles: is_owner() required for any transition into or out of ''owner''; is_staff() required for all other role changes. See migration 20260911000000.';
