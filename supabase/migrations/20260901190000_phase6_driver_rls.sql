-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 6: driver read access for job detail
-- =============================================================================
-- The driver dashboard shows, for the driver's own assigned jobs: the customer
-- name/phone and the assigned dumpster's unit number. Phase 1 gave drivers a
-- read policy on bookings ("bookings: driver reads bookings on their jobs") but
-- not on customers or dumpsters, so the joins came back empty.
--
-- These grant SELECT only, scoped exactly to rows tied to a job assigned to
-- the requesting driver — the "see it through your assigned jobs" model flagged
-- back in the Phase 2 fleet addendum.

create policy "customers: driver reads customers on their assigned jobs"
  on public.customers for select
  using (
    exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      join public.bookings b on b.id = j.booking_id
      where b.customer_id = customers.id
        and d.profile_id = auth.uid()
    )
  );

create policy "dumpsters: driver reads units on their assigned jobs"
  on public.dumpsters for select
  using (
    exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      join public.bookings b on b.id = j.booking_id
      where b.dumpster_id = dumpsters.id
        and d.profile_id = auth.uid()
    )
  );
