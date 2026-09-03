-- =============================================================================
-- Fix: 20260901190000 driver policies on customers/dumpsters joined bookings,
-- and bookings' own "customer reads own" policy reads customers -> infinite
-- recursion (42P17). Move the join into SECURITY DEFINER helpers, which bypass
-- RLS on their internal reads and break the cycle.
-- =============================================================================

drop policy if exists "customers: driver reads customers on their assigned jobs" on public.customers;
drop policy if exists "dumpsters: driver reads units on their assigned jobs" on public.dumpsters;

create or replace function public.driver_can_see_customer(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.jobs j
    join public.drivers d on d.id = j.driver_id
    join public.bookings b on b.id = j.booking_id
    where b.customer_id = p_customer_id
      and d.profile_id = auth.uid()
  );
$$;

create or replace function public.driver_can_see_dumpster(p_dumpster_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.jobs j
    join public.drivers d on d.id = j.driver_id
    join public.bookings b on b.id = j.booking_id
    where b.dumpster_id = p_dumpster_id
      and d.profile_id = auth.uid()
  );
$$;

grant execute on function public.driver_can_see_customer(uuid) to authenticated;
grant execute on function public.driver_can_see_dumpster(uuid) to authenticated;

create policy "customers: driver reads customers on their assigned jobs"
  on public.customers for select
  using (public.driver_can_see_customer(id));

create policy "dumpsters: driver reads units on their assigned jobs"
  on public.dumpsters for select
  using (public.driver_can_see_dumpster(id));
