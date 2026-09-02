-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 3: size availability function
-- =============================================================================
-- Answers "how many units of size S are free for a standard rental delivered
-- on day D" for every day in a date range, in ONE live query. Every other
-- phase's availability logic depends on this being correct.
--
-- available(S, D) = total_in_service(S) - committed_over_window(S, [D, D+rental-1])
--   floored at 0, then forced to 0 when the delivery or pickup day is blocked,
--   and D < current_date + 1 is flagged is_past (never bookable).
--
-- Design decisions baked in here:
--  * committed counts bookings by size_requested (NOT by assigned dumpster_id) —
--    an unassigned booking still commits a unit of that size.
--  * only 'cancelled' and 'returned' bookings are excluded from committed;
--    'overdue' etc. are live commitments.
--  * pickup_date IS NULL => open-ended => daterange upper-unbounded => the unit
--    stays committed to every future window (same '[]' semantics as the
--    bookings_no_overlap_per_dumpster exclusion constraint).
--  * out_of_service units are removed from the bookable total entirely.
--  * a calendar_block closes day D only if it covers D itself or D+rental-1
--    (the delivery / pickup days); a block on a middle day is ignored.
--  * a block (size-specific OR fleet-wide, size IS NULL) closes the size to 0.
--  * the current_date + 1 floor lives here, not just in the UI.

create or replace function public.size_availability(
  p_size        public.dumpster_size,
  p_from        date,
  p_to          date,
  p_rental_days integer default 5
)
returns table (
  day       date,
  total     integer,
  committed integer,
  blocked   boolean,
  is_past   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with fleet as (
    select count(*)::int as total
    from public.dumpsters
    where size = p_size
      and status <> 'out_of_service'
  ),
  days as (
    select d::date as day
    from generate_series(p_from, p_to, interval '1 day') as d
  )
  select
    days.day,
    fleet.total,
    (
      select count(*)::int
      from public.bookings b
      where b.size_requested = p_size
        and b.status not in ('cancelled', 'returned')
        and daterange(b.delivery_date, b.pickup_date, '[]')
          && daterange(days.day, days.day + (p_rental_days - 1), '[]')
    ) as committed,
    exists (
      select 1
      from public.calendar_blocks cb
      where (cb.size = p_size or cb.size is null)
        and (
          daterange(cb.start_date, cb.end_date, '[]') @> days.day
          or daterange(cb.start_date, cb.end_date, '[]')
               @> (days.day + (p_rental_days - 1))
        )
    ) as blocked,
    (days.day < current_date + 1) as is_past
  from days
  cross join fleet
  order by days.day;
$$;

comment on function public.size_availability(public.dumpster_size, date, date, integer)
  is 'Live per-day availability for a dumpster size over a date range. See migration 20260901070000.';

grant execute on function public.size_availability(public.dumpster_size, date, date, integer)
  to authenticated, service_role;
