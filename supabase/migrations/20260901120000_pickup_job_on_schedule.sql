-- =============================================================================
-- Crazy Larry's Dumpsters — fix: create the pickup job on -> pickup_scheduled
-- =============================================================================
-- 20260901100000 left this as a TODO comment. set_booking_status transitioned
-- a booking to pickup_scheduled without ever creating the pickup job row, so
-- bookings in that state had only their original delivery job.
--
-- This replaces set_booking_status with a pickup_scheduled branch, and
-- backfills the missing pickup job for the one booking already in that state.

create or replace function public.set_booking_status(
  p_booking_id uuid,
  p_to         public.booking_status
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old           public.booking_status;
  v_row           public.bookings;
  v_pickup_job_id uuid;
  j               record;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may change booking status'
      using errcode = '42501';
  end if;

  select status into v_old from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;

  if not public.booking_transition_allowed(v_old, p_to) then
    raise exception 'Illegal booking status transition: % -> %', v_old, p_to
      using errcode = '23514';
  end if;

  update public.bookings set status = p_to where id = p_booking_id returning * into v_row;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
  values ('booking', p_booking_id, v_old::text, p_to::text, auth.uid());

  -- Cancellation cascades to non-completed jobs; each change is logged.
  if p_to = 'cancelled' then
    for j in
      select id, status from public.jobs
      where booking_id = p_booking_id
        and status not in ('completed', 'cancelled')
      for update
    loop
      update public.jobs set status = 'cancelled' where id = j.id;
      insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
      values ('job', j.id, j.status::text, 'cancelled', auth.uid());
    end loop;
  end if;

  -- Entering pickup_scheduled: ensure a pickup job exists. Idempotent — a
  -- non-cancelled pickup job already on this booking means one was created on
  -- an earlier pass (e.g. overdue -> pickup_scheduled -> overdue ->
  -- pickup_scheduled), so we do nothing.
  if p_to = 'pickup_scheduled' and v_row.pickup_date is not null then
    insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
    select p_booking_id, 'pickup', null, v_row.pickup_date, 'unassigned'
    where not exists (
      select 1 from public.jobs
      where booking_id = p_booking_id
        and type = 'pickup'
        and status <> 'cancelled'
    )
    returning id into v_pickup_job_id;

    if v_pickup_job_id is not null then
      insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
      values ('job', v_pickup_job_id, null, 'unassigned', auth.uid());
    end if;
  end if;

  -- TODO(phase-6): on 'delivered' complete the delivery job (+ assigned unit
  --   -> deployed); on 'returned' complete the pickup job (+ assigned unit
  --   -> available).

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Backfill: the booking already advanced to pickup_scheduled without a pickup
-- job. Make its data match what the function should have done. Idempotent.
-- -----------------------------------------------------------------------------
with created as (
  insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
  select b.id, 'pickup', null, b.pickup_date, 'unassigned'
  from public.bookings b
  where b.id = 'ca9cb512-fea5-4cf2-8f4f-745279fc487b'
    and b.status = 'pickup_scheduled'
    and b.pickup_date is not null
    and not exists (
      select 1 from public.jobs
      where booking_id = b.id and type = 'pickup' and status <> 'cancelled'
    )
  returning id
)
insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
select 'job', id, null, 'unassigned', null
from created;
