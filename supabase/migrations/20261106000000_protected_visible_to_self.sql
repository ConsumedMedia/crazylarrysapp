-- =============================================================================
-- Crazy Larry's Dumpsters: a protected account is listed only for itself
-- =============================================================================
-- list_staff_users() now returns a protected row only when auth.uid() is that
-- row's id. One line in the WHERE clause; nothing else about the function moves
-- (signature, return columns, SECURITY DEFINER, STABLE, search_path, grants).
--
-- This is display only. It doesn't touch:
--   * is_protected or hidden_from_users on any row
--   * guard_profile_admin_fields, remove_staff_user: protection is unchanged
--   * _visible_owner_count: a protected, shown owner still counts
--   * pay_link_staff_alert_recipients: a protected, shown owner still gets the
--     fallback alert, and can still be chosen
--   * "profiles: staff full access": staff can still read a profile row directly
--
-- Probe: scripts/probe-protected-visibility.mjs (rolled back).
-- =============================================================================

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
      and (not p.is_protected or p.id = auth.uid())
      and (p.role <> 'customer' or d.id is not null or p.removed_at is not null)
    order by p.is_protected desc, p.removed_at nulls first, p.full_name nulls last, u.email;
end;
$$;

-- CREATE OR REPLACE keeps the existing grants; stated here so the file says so.
grant execute on function public.list_staff_users() to authenticated;
