-- =============================================================================
-- Crazy Larry's Dumpsters — time-of-day granularity on calendar_blocks
-- =============================================================================
-- A block can now optionally carry a start_time/end_time (e.g. 8am-10am) that
-- applies uniformly across its whole date range, alongside its existing
-- start_date/end_date. Existing date-only blocks are unaffected: both new
-- columns are nullable with no default, so every current row gets
-- start_time = NULL, end_time = NULL, which continues to mean "the whole day"
-- exactly as before.
--
-- Design decision (confirmed with the client): a time-scoped block does NOT
-- affect size_availability / customer-facing booking eligibility at all.
-- jobs.scheduled_date is a bare date with no time-of-day column anywhere in
-- the schema (route_order is a route sequence, not a clock time), so there is
-- no real data to compare a block's time window against — any attempt to
-- partially restrict same-day delivery/pickup scheduling would be inventing a
-- time the system doesn't track. So only full-day blocks (start_time is null)
-- continue to feed size_availability's `blocked` calculation; a time-scoped
-- block is staff-facing only (schedule grid + dispatch driver-day lane).
-- =============================================================================

alter table public.calendar_blocks
  add column start_time time,
  add column end_time   time;

alter table public.calendar_blocks
  add constraint calendar_blocks_time_pair_ck
    check ((start_time is null) = (end_time is null));

alter table public.calendar_blocks
  add constraint calendar_blocks_time_order_ck
    check (start_time is null or end_time > start_time);

-- -----------------------------------------------------------------------------
-- size_availability — same body as 20260915000000, one line added: a
-- time-scoped block (start_time is not null) never satisfies the blocked
-- EXISTS clause, so it can never affect customer-facing availability.
-- -----------------------------------------------------------------------------
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
          && daterange(days.day, days.day + p_rental_days, '[]')
    ) as committed,
    exists (
      select 1
      from public.calendar_blocks cb
      where (cb.size = p_size or cb.size is null)
        -- CHANGED: a time-scoped block is staff-facing only (see header) —
        -- never counts toward customer-facing availability.
        and cb.start_time is null
        and (
          daterange(cb.start_date, cb.end_date, '[]') @> days.day
          or daterange(cb.start_date, cb.end_date, '[]') @> (days.day + p_rental_days)
        )
    ) as blocked,
    (days.day < current_date + 1) as is_past
  from days
  cross join fleet
  order by days.day;
$$;

comment on function public.size_availability(public.dumpster_size, date, date, integer)
  is 'Live per-day availability for a dumpster size over a date range. Window is [day, day + rental_days] — pickup day inclusive, delivery day not counted as one of the rental_days. Time-scoped calendar_blocks (start_time is not null) never affect this — they are staff-facing only. See migration 20260922000000 (supersedes 20260915000000).';
