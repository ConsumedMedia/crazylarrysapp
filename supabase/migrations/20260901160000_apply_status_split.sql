-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 6 (B): _apply_* status split
-- =============================================================================
-- complete_job (Phase 6 C) must be callable by a DRIVER for their own job and
-- must move both dumpster and booking status. A driver-context call into
-- set_dumpster_status / set_booking_status would hit is_staff() and be rejected.
--
-- Split each into:
--   _apply_<x>_status(id, to, changed_by)  — SECURITY DEFINER, NO auth check,
--       the transition-check + FOR UPDATE + UPDATE + status_log (+ side effects).
--       REVOKEd from public/anon/authenticated; GRANTed to service_role only.
--       Reachable otherwise only as an internal call from another DEFINER fn.
--   set_<x>_status(id, to)                 — unchanged signature; keeps the
--       is_staff() guard, then calls _apply_<x>_status(id, to, auth.uid()).
--
-- Behavior-preserving for every existing caller.

-- =============================================================================
-- dumpster
-- =============================================================================
create or replace function public._apply_dumpster_status(
  p_dumpster_id uuid,
  p_to          public.dumpster_status,
  p_changed_by  uuid
)
returns public.dumpsters
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.dumpster_status;
  v_row public.dumpsters;
begin
  select status into v_old
  from public.dumpsters
  where id = p_dumpster_id
  for update;

  if not found then
    raise exception 'Dumpster % not found', p_dumpster_id using errcode = 'P0002';
  end if;

  if not public.dumpster_transition_allowed(v_old, p_to) then
    raise exception 'Illegal dumpster status transition: % -> %', v_old, p_to
      using errcode = '23514';
  end if;

  update public.dumpsters
  set status = p_to
  where id = p_dumpster_id
  returning * into v_row;

  insert into public.status_log
    (entity_type, entity_id, old_status, new_status, changed_by)
  values
    ('dumpster', p_dumpster_id, v_old::text, p_to::text, p_changed_by);

  return v_row;
end;
$$;

revoke all on function public._apply_dumpster_status(uuid, public.dumpster_status, uuid)
  from public, anon, authenticated;
grant execute on function public._apply_dumpster_status(uuid, public.dumpster_status, uuid)
  to service_role;

create or replace function public.set_dumpster_status(
  p_dumpster_id uuid,
  p_to          public.dumpster_status
)
returns public.dumpsters
language plpgsql
security invoker
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

-- =============================================================================
-- booking (carries the cancellation cascade + pickup_scheduled branch, so the
-- transition semantics travel with the transition regardless of entry point)
-- =============================================================================
create or replace function public._apply_booking_status(
  p_booking_id uuid,
  p_to         public.booking_status,
  p_changed_by uuid
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old           public.booking_status;
  v_row           public.bookings;
  v_pickup_job_id uuid;
  j               record;
begin
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
  values ('booking', p_booking_id, v_old::text, p_to::text, p_changed_by);

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
      values ('job', j.id, j.status::text, 'cancelled', p_changed_by);
    end loop;
  end if;

  -- Entering pickup_scheduled: ensure a pickup job exists (idempotent).
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
      values ('job', v_pickup_job_id, null, 'unassigned', p_changed_by);
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public._apply_booking_status(uuid, public.booking_status, uuid)
  from public, anon, authenticated;
grant execute on function public._apply_booking_status(uuid, public.booking_status, uuid)
  to service_role;

create or replace function public.set_booking_status(
  p_booking_id uuid,
  p_to         public.booking_status
)
returns public.bookings
language plpgsql
security invoker
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
