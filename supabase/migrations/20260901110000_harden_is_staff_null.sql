-- =============================================================================
-- Crazy Larry's Dumpsters — harden is_staff() / is_owner() against NULL
-- =============================================================================
-- current_user_role() returns NULL when there is no auth context (no JWT).
-- The previous bodies then returned NULL rather than false, and every guard
-- written as `if not public.is_staff() then raise ...` silently did NOT fire
-- (NOT NULL is NULL, and `IF NULL THEN` is false).
--
-- Callers affected: set_dumpster_status, set_booking_status,
-- set_booking_docusign_status, and the enforce_profile_role_change trigger.
-- Coalescing to false closes that: no session => not staff, not owner.
-- Authenticated staff/owner sessions are unchanged. RLS policies that already
-- treated NULL as falsy are also unaffected.

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() in ('staff', 'owner'), false);
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = 'owner', false);
$$;
