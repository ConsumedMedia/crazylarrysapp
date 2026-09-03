-- =============================================================================
-- _apply_booking_status: on cancel, also NULL out bookings.dumpster_id after
-- freeing the unit — a cancelled booking should not keep a live FK to a can
-- that's back in the pool.
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
  v_dstatus       public.dumpster_status;
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

    if v_row.dumpster_id is not null then
      select status into v_dstatus from public.dumpsters where id = v_row.dumpster_id;
      if v_dstatus in ('reserved', 'deployed', 'overdue') then
        perform public._apply_dumpster_status(v_row.dumpster_id, 'available', p_changed_by);
      end if;
      update public.bookings set dumpster_id = null where id = p_booking_id
      returning * into v_row;
    end if;
  end if;

  if p_to = 'pickup_scheduled' and v_row.pickup_date is not null then
    insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
    select p_booking_id, 'pickup', null, v_row.pickup_date, 'unassigned'
    where not exists (
      select 1 from public.jobs
      where booking_id = p_booking_id and type = 'pickup' and status <> 'cancelled'
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
