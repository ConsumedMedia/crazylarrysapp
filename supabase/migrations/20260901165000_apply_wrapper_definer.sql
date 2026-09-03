-- =============================================================================
-- Crazy Larry's Dumpsters — fix: set_*_status wrappers must be SECURITY DEFINER
-- =============================================================================
-- 20260901160000 made set_dumpster_status / set_booking_status SECURITY INVOKER
-- while delegating to _apply_*_status, which is REVOKEd from authenticated. Via
-- PostgREST a staff user calls the wrapper as role `authenticated`, so the
-- delegating call failed:
--   ERROR: 42501: permission denied for function _apply_dumpster_status
--
-- The wrappers do nothing but check is_staff() and delegate, so running them
-- SECURITY DEFINER (as owner) is correct: is_staff() is still the authorization,
-- and _apply_* stays unreachable to a direct authenticated/anon call.

create or replace function public.set_dumpster_status(
  p_dumpster_id uuid,
  p_to          public.dumpster_status
)
returns public.dumpsters
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may change dumpster status'
      using errcode = '42501';
  end if;
  return public._apply_dumpster_status(p_dumpster_id, p_to, auth.uid());
end;
$$;

create or replace function public.set_booking_status(
  p_booking_id uuid,
  p_to         public.booking_status
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may change booking status'
      using errcode = '42501';
  end if;
  return public._apply_booking_status(p_booking_id, p_to, auth.uid());
end;
$$;
