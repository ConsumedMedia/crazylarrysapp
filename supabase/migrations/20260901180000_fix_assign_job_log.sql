-- =============================================================================
-- Fix: assign_job logged old_status AFTER the UPDATE, so it always recorded
-- 'assigned -> assigned'. Capture the pre-update status.
-- =============================================================================
create or replace function public.assign_job(
  p_job_id      uuid,
  p_driver_id   uuid,
  p_dumpster_id uuid default null,
  p_override    boolean default false
)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job         public.jobs;
  v_old_status  public.job_status;
  v_booking     public.bookings;
  v_check       record;
  v_driver_name text;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job % not found', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status not in ('unassigned', 'assigned') then
    raise exception 'Job is % — cannot assign', v_job.status using errcode = '23514';
  end if;
  v_old_status := v_job.status;

  select * into v_booking from public.bookings where id = v_job.booking_id;
  if v_booking.status in ('cancelled', 'returned') then
    raise exception 'Booking is % — cannot assign its jobs', v_booking.status
      using errcode = '23514';
  end if;

  select * into v_check from public.check_job_assignment(p_job_id, p_driver_id);

  if not v_check.allowed then
    raise exception 'Assignment blocked for %', coalesce(v_check.truck_nickname, 'that driver''s truck')
      using errcode = '23514', detail = v_check.blockers::text, hint = 'assignment_blocked';
  end if;
  if v_check.requires_override and not p_override then
    raise exception 'Assignment needs confirmation'
      using errcode = 'P0001', detail = v_check.warnings::text, hint = 'override_required';
  end if;

  if v_job.type = 'delivery' and p_dumpster_id is not null then
    perform public.assign_unit(v_job.booking_id, p_dumpster_id);
  end if;

  select full_name into v_driver_name from public.drivers where id = p_driver_id;

  update public.jobs
  set driver_id = p_driver_id, status = 'assigned'
  where id = p_job_id
  returning * into v_job;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by, note)
  values ('job', p_job_id, v_old_status::text, 'assigned', auth.uid(),
          'assigned to ' || coalesce(v_driver_name, p_driver_id::text)
          || case when p_override then ' (override)' else '' end);

  return v_job;
end;
$$;
