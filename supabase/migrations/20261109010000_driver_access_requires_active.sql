-- Driver access requires drivers.active.
--
-- Until now every driver read policy, the photo insert policies (table and
-- storage) and the driver branch of complete_job matched on
-- d.profile_id = auth.uid() alone, so a deactivated driver could still read
-- every job ever assigned to them (and the bookings, customers, units, truck
-- and notifications behind those jobs), add photos and complete an assigned
-- job. Each one now also requires d.active.
--
-- Built from the LIVE definitions (pg_policies, pg_get_functiondef, read
-- 2026-11-09), not from older migration files: the live database carries
-- main's DocuSign schema. The only change in each object is the added
-- "d.active" condition.
--
-- Kept identical: policy names, commands, roles and the rest of each
-- expression (ALTER POLICY changes only USING / WITH CHECK); function names,
-- signatures, SECURITY DEFINER, search_path, owner and grants (CREATE OR
-- REPLACE keeps the owner and ACL).
--
-- Deliberately NOT changed:
--   * "drivers: driver reads own record": an inactive driver still reads their
--     own drivers row, so /driver opens and shows the inactive banner.
--   * every staff policy: staff and owners (including owners who also have a
--     driver row) see everything through is_staff(), active or not.
--   * _create_booking_core and every other function.
--
-- Rolled-back probe: scripts/probe-driver-active.mjs
-- Read-only post-apply check: scripts/check-driver-active-applied.mjs

-- jobs
alter policy "jobs: driver reads assigned jobs" on public.jobs
  using (
    exists (
      select 1
      from public.drivers d
      where d.id = jobs.driver_id
        and d.profile_id = auth.uid()
        and d.active
    )
  );

-- bookings
alter policy "bookings: driver reads bookings on their jobs" on public.bookings
  using (
    exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where j.booking_id = bookings.id
        and d.profile_id = auth.uid()
        and d.active
    )
  );

-- job_photos: read
alter policy "job_photos: driver reads own job photos" on public.job_photos
  using (
    exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where j.id = job_photos.job_id
        and d.profile_id = auth.uid()
        and d.active
    )
  );

-- job_photos: insert
alter policy "job_photos: driver inserts own job photos" on public.job_photos
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where j.id = job_photos.job_id
        and d.profile_id = auth.uid()
        and d.active
    )
  );

-- trucks
alter policy "trucks: driver reads own assigned truck" on public.trucks
  using (
    exists (
      select 1
      from public.drivers d
      where d.id = trucks.assigned_driver_id
        and d.profile_id = auth.uid()
        and d.active
    )
  );

-- notifications_log
alter policy "notifications_log: driver reads own" on public.notifications_log
  using (
    exists (
      select 1
      from public.drivers d
      where d.id = notifications_log.driver_id
        and d.profile_id = auth.uid()
        and d.active
    )
  );

-- storage: job-photos upload
alter policy "job-photos: driver uploads own job photos" on storage.objects
  with check (
    bucket_id = 'job-photos'
    and exists (
      select 1
      from public.jobs j
      join public.drivers d on d.id = j.driver_id
      where d.profile_id = auth.uid()
        and d.active
        and j.id::text = (storage.foldername(objects.name))[1]
    )
  );

-- customers (policy "customers: driver reads customers on their assigned jobs")
CREATE OR REPLACE FUNCTION public.driver_can_see_customer(p_customer_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.jobs j
    join public.drivers d on d.id = j.driver_id
    join public.bookings b on b.id = j.booking_id
    where b.customer_id = p_customer_id
      and d.profile_id = auth.uid()
      and d.active
  );
$function$;

-- dumpsters (policy "dumpsters: driver reads units on their assigned jobs")
CREATE OR REPLACE FUNCTION public.driver_can_see_dumpster(p_dumpster_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.jobs j
    join public.drivers d on d.id = j.driver_id
    join public.bookings b on b.id = j.booking_id
    where b.dumpster_id = p_dumpster_id
      and d.profile_id = auth.uid()
      and d.active
  );
$function$;

-- complete_job: only the driver branch of the permission check changes.
CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid)
 RETURNS jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_job      public.jobs;
  v_booking  public.bookings;
  v_bstatus  public.booking_status;
  v_dstatus  public.dumpster_status;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job % not found', p_job_id using errcode = 'P0002';
  end if;

  if not (
    public.is_staff()
    or exists (
      select 1 from public.drivers d
      where d.id = v_job.driver_id and d.profile_id = auth.uid() and d.active
    )
  ) then
    raise exception 'Not authorized to complete this job' using errcode = '42501';
  end if;

  if v_job.status <> 'assigned' then
    raise exception 'Job is % — only an assigned job can be completed', v_job.status
      using errcode = '23514';
  end if;

  select * into v_booking from public.bookings where id = v_job.booking_id for update;
  if v_booking.status = 'cancelled' then
    raise exception 'Booking is cancelled' using errcode = '23514';
  end if;

  update public.jobs
  set status = 'completed', completed_at = now()
  where id = p_job_id
  returning * into v_job;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
  values ('job', p_job_id, 'assigned', 'completed', auth.uid());

  if v_job.type = 'delivery' then
    if v_booking.status = 'confirmed' then
      perform public._apply_booking_status(v_job.booking_id, 'delivered', auth.uid());
    end if;
    select status into v_bstatus from public.bookings where id = v_job.booking_id;
    if v_bstatus = 'delivered' then
      perform public._apply_booking_status(v_job.booking_id, 'active', auth.uid());
    end if;

    if v_booking.dumpster_id is not null then
      select status into v_dstatus from public.dumpsters where id = v_booking.dumpster_id;
      if v_dstatus = 'reserved' then
        perform public._apply_dumpster_status(v_booking.dumpster_id, 'deployed', auth.uid());
      end if;
    end if;

  elsif v_job.type = 'pickup' then
    if v_booking.status in ('pickup_scheduled', 'overdue') then
      perform public._apply_booking_status(v_job.booking_id, 'returned', auth.uid());
    end if;

    if v_booking.dumpster_id is not null then
      select status into v_dstatus from public.dumpsters where id = v_booking.dumpster_id;
      if v_dstatus in ('deployed', 'overdue') then
        perform public._apply_dumpster_status(v_booking.dumpster_id, 'available', auth.uid());
      end if;
    end if;
  end if;

  return v_job;
end;
$function$;
