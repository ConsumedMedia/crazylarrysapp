-- =============================================================================
-- Crazy Larry's Dumpsters: the last-owner rule counts only owners who can
-- actually run the business
-- =============================================================================
-- Before: the guard counted every owner who was not removed and not hidden
-- (_visible_owner_count). The protected account counted, and it can never be
-- removed, so the guard could never fire for anyone else. An owner who had
-- never accepted their invite counted too.
--
-- After: at least one COUNTED owner must remain. Counted means all of:
--   * role owner, not removed, not hidden, not protected
--   * a login that has confirmed its email (accepted the invite), is not
--     banned, and is not deleted
-- The guard fires only when the owner being demoted or removed is counted
-- themselves; losing an owner who doesn't count can't leave fewer counted ones.
--
-- Unchanged on purpose:
--   * _visible_owner_count() stays as it is (the pay-link alert fallback and
--     anything else reading it see no difference); the guard just stops using it.
--   * Protection, the admin-flags rule and the delete rule.
--   * The service role, raw pg, migrations and the dashboard still pass this
--     guard, as before. They still can't demote an owner, though: the separate
--     role-change trigger (enforce_profile_role_change) needs an owner session
--     for that. So the way out is the one the message gives: add another owner
--     first, and have them accept the invite.
--
-- Rolled-back probe: scripts/probe-last-owner.mjs
-- =============================================================================

-- A login that is usable: confirmed, not banned, not deleted. Reads auth.users,
-- so SECURITY DEFINER. Called from the guard trigger, which runs as the
-- invoking role, hence the grant to authenticated.
create or replace function public._owner_login_active(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_id
      and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until <= now())
      and u.deleted_at is null
  );
$$;

-- Counted owners other than p_id (null = all of them). Split out so the probe
-- can replace it with a fake count and never touch a real owner.
create or replace function public._counted_owners_other_than(p_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.profiles p
  where p.role = 'owner'
    and p.removed_at is null
    and not p.hidden_from_users
    and not p.is_protected
    and p.id is distinct from p_id
    and public._owner_login_active(p.id);
$$;

grant execute on function public._owner_login_active(uuid) to authenticated;
grant execute on function public._counted_owners_other_than(uuid) to authenticated;

-- Same check, same hint, plus what to do about it. CREATE OR REPLACE keeps grants.
create or replace function public._assert_owners_remain(p_remaining integer)
returns void
language plpgsql
immutable
as $$
begin
  if p_remaining is null or p_remaining < 1 then
    raise exception 'At least one active owner must remain. Add another owner first; they count once they have accepted their invite.'
      using errcode = '42501', hint = 'last_owner';
  end if;
end;
$$;

-- The guard trigger, rebuilt from the live definition
-- (md5 8f67c6178fbabeb2dfaf378f6e334905). Only the last-owner block changes.
-- CREATE OR REPLACE keeps the trigger attached and the grants as they are.
create or replace function public.guard_profile_admin_fields()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  -- Not a user session: service role, raw pg, migrations, dashboard. Allow.
  if v_role not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    -- Accounts are removed (soft) via remove_staff_user, or hard-deleted only
    -- by the server's service-role path. Never by a user session.
    raise exception 'Profiles cannot be deleted from a user session'
      using errcode = '42501', hint = 'profile_delete';
  end if;

  -- Admin columns change only inside the remove/restore RPCs (which run as
  -- the function owner), never by a direct client write — otherwise anyone
  -- could flag themselves protected via "profiles: user updates own".
  if current_user in ('authenticated', 'anon') and (
       new.is_protected      is distinct from old.is_protected or
       new.hidden_from_users is distinct from old.hidden_from_users or
       new.removed_at        is distinct from old.removed_at or
       new.removed_by        is distinct from old.removed_by) then
    raise exception 'Account flags cannot be changed directly'
      using errcode = '42501', hint = 'admin_fields';
  end if;

  if old.is_protected then
    if new.role is distinct from old.role then
      raise exception 'This account is protected: its role cannot be changed'
        using errcode = '42501', hint = 'protected';
    end if;
    if new.removed_at is distinct from old.removed_at then
      raise exception 'This account is protected and cannot be removed'
        using errcode = '42501', hint = 'protected';
    end if;
    -- A no-op write (same values, e.g. the seed script re-asserting a role)
    -- is fine; any real change by someone other than the account itself isn't.
    if auth.uid() is distinct from old.id and new is distinct from old then
      raise exception 'This account is protected and cannot be edited'
        using errcode = '42501', hint = 'protected';
    end if;
  end if;

  -- Last-owner guard: a COUNTED owner (see _counted_owners_other_than) losing
  -- owner status or being removed must leave at least one other counted owner.
  if old.role = 'owner' and old.removed_at is null and not old.hidden_from_users
     and not old.is_protected
     and (new.role is distinct from 'owner' or new.removed_at is not null)
     and public._owner_login_active(old.id) then
    -- Serialize concurrent demotions so two owners can't remove each other.
    perform pg_advisory_xact_lock(hashtext('cl_last_owner_guard'));
    perform public._assert_owners_remain(public._counted_owners_other_than(old.id));
  end if;

  return new;
end;
$$;
