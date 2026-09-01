-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 1 addendum
--   1. auth.users -> public.profiles signup trigger
--   2. Database-level double-booking prevention (exclusion constraint)
-- =============================================================================

-- =============================================================================
-- 1. SIGNUP TRIGGER: auto-create a profiles row for every new auth user
-- =============================================================================
-- SECURITY DEFINER: the function runs as its owner (a privileged role) so it can
-- insert into public.profiles on behalf of a user who does not yet have a row
-- and whose own RLS context would otherwise block the write.
--
-- role is HARD-CODED to 'customer' here — it is deliberately NOT read from
-- raw_user_meta_data, so a self-service signup cannot escalate itself to
-- 'staff' / 'owner' by passing metadata. Elevating a role is done later by
-- staff via an authenticated session (see profiles_enforce_role_change).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    'customer',
    new.raw_user_meta_data ->> 'full_name'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 2. DOUBLE-BOOKING PREVENTION
-- =============================================================================
-- btree_gist lets a GiST exclusion constraint combine a plain-equality column
-- (dumpster_id) with a range-overlap operator (&&).
create extension if not exists btree_gist;

-- Open-ended bookings (pickup_date IS NULL) are treated as extending
-- indefinitely: the range upper bound is left unbounded, so an open-ended
-- booking blocks every later booking on that dumpster until it is closed out
-- (pickup_date set) or cancelled. This is the safe default for a physical
-- asset — an un-returned dumpster is genuinely unavailable. Staff clear it by
-- setting pickup_date or moving status to 'returned'/'cancelled'.
--
-- Range is half-open [delivery_date, pickup_date): a booking that ends on
-- day X does not conflict with one that starts on day X, allowing same-day
-- turnaround. Switch the daterange bound flag to '[]' if you want to force a
-- buffer day between rentals of the same unit.
--
-- The constraint is partial:
--   * only ACTIVE bookings matter — 'cancelled' and 'returned' are excluded
--   * only ASSIGNED bookings matter — dumpster_id IS NULL (not yet assigned)
--     never conflicts
alter table public.bookings
  add constraint bookings_no_overlap_per_dumpster
  exclude using gist (
    dumpster_id with =,
    daterange(delivery_date, pickup_date, '[)') with &&
  )
  where (
    dumpster_id is not null
    and status not in ('cancelled', 'returned')
  );
