-- =============================================================================
-- Crazy Larry's Dumpsters — owner Users page: protected / hidden accounts,
-- soft removal, last-owner guard
-- =============================================================================
-- Additive only. Production's 0a7e76b code never reads or writes these columns
-- and never deletes a profile from a user session, so it keeps working
-- unchanged (probed before applying).
--
-- Two independent flags (Nathan, 2026-10-05):
--   is_protected       — enforced here: no user session may change its role,
--                        remove it, delete it, or (unless it's their own row)
--                        edit it at all.
--   hidden_from_users  — display only: left out of list_staff_users() and of
--                        the owner count. No enforcement.
-- Seed-owner + seed drivers are both; nathan@crossingriverstudios.com is
-- protected but shown; the info@ test driver is hidden but not protected.
--
-- "User session" = the request's JWT role is authenticated/anon. That holds
-- inside SECURITY DEFINER RPCs too (the claims travel with the request), so
-- the rules below apply to them. The service role, raw pg / DATABASE_URL,
-- migrations and the dashboard SQL editor carry no such claim and pass
-- straight through — by design, so seed/integration scripts and Nathan's own
-- dashboard access are never blocked.
-- =============================================================================

alter table public.profiles
  add column is_protected      boolean not null default false,
  add column hidden_from_users boolean not null default false,
  add column removed_at        timestamptz,
  add column removed_by        uuid references public.profiles(id) on delete set null;

comment on column public.profiles.is_protected is
  'No user session may change role, remove, delete, or (unless self) edit this account. Enforced by profiles_guard_admin_fields.';
comment on column public.profiles.hidden_from_users is
  'Left out of the owner Users list and the last-owner count (service/test accounts). Display only.';
comment on column public.profiles.removed_at is
  'Set by remove_staff_user(): access cleared, login banned, record kept. NULL = not removed.';

-- The protected account. Matched on id AND email so a wrong id can't
-- silently flag someone else.
do $$
declare v_n int;
begin
  update public.profiles p set is_protected = true
  from auth.users u
  where p.id = u.id
    and p.id = '554aa729-d7df-45e4-b48b-c7132c304af5'
    and lower(u.email) = 'nathan@crossingriverstudios.com';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'protected account not found (updated % rows)', v_n;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Owner count + the last-owner check, split so the check can be exercised in
-- isolation with a fake count.
-- -----------------------------------------------------------------------------
create or replace function public._visible_owner_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.profiles
  where role = 'owner' and removed_at is null and not hidden_from_users;
$$;

create or replace function public._assert_owners_remain(p_remaining integer)
returns void
language plpgsql
immutable
as $$
begin
  if p_remaining is null or p_remaining < 1 then
    raise exception 'At least one owner must remain'
      using errcode = '42501', hint = 'last_owner';
  end if;
end;
$$;

-- Called from the trigger below, which runs as the invoking role.
grant execute on function public._visible_owner_count() to authenticated;
grant execute on function public._assert_owners_remain(integer) to authenticated;

-- -----------------------------------------------------------------------------
-- The guard trigger. Separate from profiles_enforce_role_change (unchanged).
-- -----------------------------------------------------------------------------
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

  -- Last-owner guard: a counted owner losing owner status or being removed.
  if old.role = 'owner' and old.removed_at is null and not old.hidden_from_users
     and (new.role is distinct from 'owner' or new.removed_at is not null) then
    -- Serialize concurrent demotions so two owners can't remove each other.
    perform pg_advisory_xact_lock(hashtext('cl_last_owner_guard'));
    perform public._assert_owners_remain(public._visible_owner_count() - 1);
  end if;

  return new;
end;
$$;

create trigger profiles_guard_admin_fields
  before update or delete on public.profiles
  for each row execute function public.guard_profile_admin_fields();

-- -----------------------------------------------------------------------------
-- RPCs for the Users page. Owner-only, checked inside.
-- -----------------------------------------------------------------------------
create or replace function public.list_staff_users()
returns table (
  id                 uuid,
  full_name          text,
  phone              text,
  role               public.user_role,
  email              text,
  is_protected       boolean,
  invited_at         timestamptz,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  banned_until       timestamptz,
  removed_at         timestamptz,
  driver_id          uuid,
  driver_active      boolean,
  vehicle_info       text,
  truck_id           uuid,
  truck_nickname     text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, p.phone, p.role, u.email::text, p.is_protected,
           u.invited_at, u.email_confirmed_at, u.last_sign_in_at, u.banned_until,
           p.removed_at, d.id, d.active, d.vehicle_info, t.id, t.nickname
    from public.profiles p
    join auth.users u on u.id = p.id
    left join public.drivers d on d.profile_id = p.id
    left join public.trucks t on t.assigned_driver_id = d.id
    where not p.hidden_from_users
      and (p.role <> 'customer' or d.id is not null or p.removed_at is not null)
    order by p.is_protected desc, p.removed_at nulls first, p.full_name nulls last, u.email;
end;
$$;

create or replace function public.open_jobs_for_profile(p_profile_id uuid)
returns table (
  job_id           uuid,
  booking_id       uuid,
  job_type         public.job_type,
  scheduled_date   date,
  delivery_address text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  return query
    select j.id, j.booking_id, j.type, j.scheduled_date, b.delivery_address
    from public.jobs j
    join public.drivers d on d.id = j.driver_id
    join public.bookings b on b.id = j.booking_id
    where d.profile_id = p_profile_id and j.status = 'assigned'
    order by j.scheduled_date nulls last;
end;
$$;

-- Every column that points at a profile. Zero = safe to hard-delete without
-- losing anything (audit attribution included).
create or replace function public.account_reference_count(p_profile_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare v int;
begin
  if not public.is_owner() then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  select
      (select count(*) from public.customers where profile_id = p_profile_id)
    + (select count(*) from public.bookings where created_by = p_profile_id or driveway_fee_applied_by = p_profile_id)
    + (select count(*) from public.drivers where profile_id = p_profile_id)
    + (select count(*) from public.invoices where recorded_by = p_profile_id)
    + (select count(*) from public.status_log where changed_by = p_profile_id)
    + (select count(*) from public.calendar_blocks where created_by = p_profile_id)
    + (select count(*) from public.cl_pricing where updated_by = p_profile_id)
    + (select count(*) from public.cl_pricing_settings where updated_by = p_profile_id)
    + (select count(*) from public.quickbooks_connection where connected_by = p_profile_id)
    + (select count(*) from public.booking_change_requests where requested_by = p_profile_id or resolved_by = p_profile_id)
    + (select count(*) from public.job_photos where uploaded_by = p_profile_id)
    + (select count(*) from public.profiles where removed_by = p_profile_id)
  into v;
  return v;
end;
$$;

-- Database half of "Remove": clears access, keeps the record. The server
-- action bans the login (auth admin API) only after this succeeds.
create or replace function public.remove_staff_user(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p          public.profiles%rowtype;
  v_driver   uuid;
  v_open     text;
begin
  if not public.is_owner() then
    raise exception 'Owner access required' using errcode = '42501';
  end if;

  select * into p from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if p.is_protected then
    raise exception 'This account is protected and cannot be removed'
      using errcode = '42501', hint = 'protected';
  end if;
  if p.removed_at is not null then
    raise exception 'Account is already removed' using errcode = 'P0001';
  end if;

  select id into v_driver from public.drivers where profile_id = p_profile_id;
  if v_driver is not null then
    select string_agg(j.type || ' ' || coalesce(j.scheduled_date::text, 'unscheduled'), ', '
                      order by j.scheduled_date)
      into v_open
    from public.jobs j where j.driver_id = v_driver and j.status = 'assigned';
    if v_open is not null then
      raise exception 'Driver has open jobs — reassign them first: %', v_open
        using errcode = 'P0001', hint = 'open_jobs';
    end if;
  end if;

  -- The role change still runs through profiles_enforce_role_change
  -- (is_owner) and the guard trigger (protected, last owner).
  update public.profiles
     set role = 'customer', removed_at = now(), removed_by = auth.uid()
   where id = p_profile_id;

  if v_driver is not null then
    update public.drivers set active = false where id = v_driver;
    update public.trucks set assigned_driver_id = null where assigned_driver_id = v_driver;
  end if;
end;
$$;

-- Clears the removed state only. Access is granted again through the normal
-- edit flow — restoring never hands back privileges on its own.
create or replace function public.restore_staff_user(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  update public.profiles set removed_at = null, removed_by = null
   where id = p_profile_id and removed_at is not null;
  if not found then
    raise exception 'Account is not removed' using errcode = 'P0001';
  end if;
end;
$$;

grant execute on function public.list_staff_users() to authenticated;
grant execute on function public.open_jobs_for_profile(uuid) to authenticated;
grant execute on function public.account_reference_count(uuid) to authenticated;
grant execute on function public.remove_staff_user(uuid) to authenticated;
grant execute on function public.restore_staff_user(uuid) to authenticated;
