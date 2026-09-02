-- =============================================================================
-- Crazy Larry's Dumpsters — double-booking: mandatory buffer day
-- =============================================================================
-- Client confirmed next-day is the earliest possible delivery: a unit is never
-- reused on the same calendar day it comes off another job. Switch the
-- exclusion constraint's range bound from half-open '[)' (which allowed a
-- booking to start the same day another ended) to closed '[]'.
--
-- Effects of '[]':
--   * [Jan 1, Jan 5] and [Jan 5, Jan 10] now OVERLAP on Jan 5 -> rejected.
--   * A same-day booking (delivery_date = pickup_date) is now a non-empty
--     single-day range and is therefore protected too (under '[)' it was an
--     empty range that conflicted with nothing).
--   * pickup_date IS NULL still yields an upper-unbounded range (open-ended
--     booking blocks everything after it until closed out).
--
-- Supersedes the constraint definition in 20260901010000 (left unedited).

alter table public.bookings
  drop constraint bookings_no_overlap_per_dumpster;

alter table public.bookings
  add constraint bookings_no_overlap_per_dumpster
  exclude using gist (
    dumpster_id with =,
    daterange(delivery_date, pickup_date, '[]') with &&
  )
  where (
    dumpster_id is not null
    and status not in ('cancelled', 'returned')
  );
