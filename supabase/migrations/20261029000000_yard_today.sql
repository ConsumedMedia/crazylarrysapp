-- "Today" in the yard (America/New_York), not UTC.
--
-- The database session time zone is UTC, so current_date is already tomorrow
-- from 8 PM EDT / 7 PM EST until midnight. size_availability marked the true
-- tomorrow as past (and _create_booking_core, behind create_booking and
-- staff_create_booking, refused it), and mark_overdue_bookings would treat a
-- pickup due today as overdue if it ran in the evening.
--
-- Additive: one new function, and one expression swapped in each of two
-- existing functions. Both are rebuilt from their live definitions with
-- CREATE OR REPLACE, so signatures, return types, SECURITY DEFINER, the pinned
-- search_path, owner and grants are all unchanged.
--
-- The zone name matches YARD_TIME_ZONE in lib/time/yard.ts (yardToday()).
-- Probe (always rolled back): scripts/probe-yard-today.mjs.

create or replace function public.yard_today(p_now timestamptz default now())
returns date
language sql
stable
set search_path = public
as $$
  select (p_now at time zone 'America/New_York')::date
$$;

comment on function public.yard_today(timestamptz) is
  'The yard''s calendar day (America/New_York) at p_now (default now()). Use instead of current_date, which is the UTC day.';

-- Private: only called from SECURITY DEFINER functions, which run it as their
-- owner (postgres). No API role needs it.
revoke all on function public.yard_today(timestamptz) from public, anon, authenticated, service_role;

-- public.size_availability(dumpster_size,date,date,integer)
-- Live definition md5 51914b24749b31f195d9204142e692c8 (read 2026-10-29T20:27:00.300Z).
-- Security definer: true; config: ["search_path=public"]; returns: TABLE(day date, total integer, committed integer, blocked boolean, is_past boolean).
-- ACL (unchanged by CREATE OR REPLACE): {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- Only change: (days.day < current_date + 1) as is_past  ->  (days.day < public.yard_today() + 1) as is_past
CREATE OR REPLACE FUNCTION public.size_availability(p_size dumpster_size, p_from date, p_to date, p_rental_days integer DEFAULT 5)
 RETURNS TABLE(day date, total integer, committed integer, blocked boolean, is_past boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    (days.day < public.yard_today() + 1) as is_past
  from days
  cross join fleet
  order by days.day;
$function$;

-- public.mark_overdue_bookings()
-- Live definition md5 89d0bd7bc6ac6ef10e0c60433f8671ec (read 2026-10-29T20:27:00.315Z).
-- Security definer: true; config: ["search_path=public"]; returns: SETOF uuid.
-- ACL (unchanged by CREATE OR REPLACE): {postgres=X/postgres,service_role=X/postgres}
-- Only change: and pickup_date < current_date  ->  and pickup_date < public.yard_today()
CREATE OR REPLACE FUNCTION public.mark_overdue_bookings()
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  b record;
begin
  for b in
    select id, status from public.bookings
    where status in ('active', 'pickup_scheduled')
      and pickup_date is not null
      and pickup_date < public.yard_today()
    for update
  loop
    update public.bookings set status = 'overdue' where id = b.id;
    insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
    values ('booking', b.id, b.status::text, 'overdue', null);
    return next b.id;
  end loop;
  return;
end;
$function$;
