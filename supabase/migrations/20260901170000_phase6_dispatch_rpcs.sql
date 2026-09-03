-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 6 (C): dispatch & driver RPCs
-- =============================================================================
--   infer_job_tags            — heuristic tags from debris_type (create_booking)
--   check_job_assignment      — truck capacity + restriction check (preview + gate)
--   assign_unit / clear_unit  — booking.dumpster_id + available<->reserved
--   assign_job / unassign_job — job <-> driver, gated by check_job_assignment
--   set_route_order           — manual per-driver-per-day ordering
--   complete_job              — driver or staff; job -> completed + downstream
--   confirm_job_tags          — dispatcher reviews tags (sets job_tags_confirmed_at)
--   _apply_booking_status     — REPLACED to free the unit on cancel cascade
--   create_booking            — REPLACED to seed job_tags via infer_job_tags
-- =============================================================================

-- Audit detail for job assignment / reassignment (old_status == new_status on
-- reassignment, so the note carries the "what happened").
alter table public.status_log add column if not exists note text;

-- -----------------------------------------------------------------------------
-- infer_job_tags
-- -----------------------------------------------------------------------------
create or replace function public.infer_job_tags(p_debris_type text)
returns text[]
language sql
immutable
as $$
  select coalesce(array(
    select tag from (values
      ('roofing',            p_debris_type ~* 'roof'),
      ('stone_concrete',     p_debris_type ~* '(concrete|stone|brick|masonry|gravel|\mdirt\M)'),
      ('heavy_construction', p_debris_type ~* '(construction|demolition|\mdemo\M|structural)')
    ) as v(tag, hit)
    where hit
  ), '{}'::text[]);
$$;

-- =============================================================================
-- _apply_booking_status — REPLACE: cancel cascade also frees the unit
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
    -- non-completed jobs -> cancelled
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

    -- free the assigned unit if it's tied up
    if v_row.dumpster_id is not null then
      select status into v_dstatus from public.dumpsters where id = v_row.dumpster_id;
      if v_dstatus in ('reserved', 'deployed', 'overdue') then
        perform public._apply_dumpster_status(v_row.dumpster_id, 'available', p_changed_by);
      end if;
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

-- =============================================================================
-- create_booking — REPLACE: seed job_tags from debris_type
-- =============================================================================
create or replace function public.create_booking(
  p_size             public.dumpster_size,
  p_delivery_date    date,
  p_delivery_address text,
  p_contact_name     text,
  p_rental_days      integer default 5,
  p_placement_notes  text default null,
  p_debris_type      text default null,
  p_contact_email    text default null,
  p_contact_phone    text default null,
  p_company_name     text default null,
  p_profile_id       uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_id     uuid;
  v_pickup_date     date;
  v_quote           record;
  v_avail           record;
  v_booking_id      uuid;
  v_delivery_job_id uuid;
begin
  if p_delivery_date is null then
    raise exception 'delivery_date is required' using errcode = '22004';
  end if;
  if coalesce(btrim(p_delivery_address), '') = '' then
    raise exception 'delivery_address is required' using errcode = '22004';
  end if;
  if coalesce(btrim(p_contact_name), '') = '' then
    raise exception 'contact_name is required' using errcode = '22004';
  end if;
  if p_rental_days is null or p_rental_days < 1 or p_rental_days > 60 then
    raise exception 'rental_days out of range' using errcode = '22003';
  end if;

  perform pg_advisory_xact_lock(hashtext('cl_booking:' || p_size::text));

  select * into v_quote from public.booking_quote(p_size);

  select * into v_avail
  from public.size_availability(p_size, p_delivery_date, p_delivery_date, p_rental_days)
  limit 1;

  if v_avail.is_past then
    raise exception 'Delivery date must be tomorrow or later'
      using errcode = 'P0001', hint = 'unavailable';
  end if;
  if v_avail.blocked then
    raise exception 'Delivery on % is blocked for %', p_delivery_date, p_size
      using errcode = 'P0001', hint = 'unavailable';
  end if;
  if (v_avail.total - v_avail.committed) <= 0 then
    raise exception 'No % units available for delivery on %', p_size, p_delivery_date
      using errcode = 'P0001', hint = 'unavailable';
  end if;

  v_pickup_date := p_delivery_date + (p_rental_days - 1);

  if p_profile_id is not null then
    select id into v_customer_id from public.customers where profile_id = p_profile_id;
    if v_customer_id is null then
      insert into public.customers (profile_id, full_name, email, phone, company_name)
      values (p_profile_id, p_contact_name, p_contact_email, p_contact_phone, p_company_name)
      returning id into v_customer_id;
    else
      update public.customers set
        full_name = p_contact_name,
        email = coalesce(p_contact_email, email),
        phone = coalesce(p_contact_phone, phone),
        company_name = coalesce(p_company_name, company_name)
      where id = v_customer_id;
    end if;
  elsif p_contact_email is not null then
    select id into v_customer_id
    from public.customers
    where profile_id is null and lower(email) = lower(p_contact_email)
    order by created_at asc limit 1;
    if v_customer_id is null then
      insert into public.customers (full_name, email, phone, company_name)
      values (p_contact_name, p_contact_email, p_contact_phone, p_company_name)
      returning id into v_customer_id;
    else
      update public.customers set
        full_name = p_contact_name,
        phone = coalesce(p_contact_phone, phone),
        company_name = coalesce(p_company_name, company_name)
      where id = v_customer_id;
    end if;
  else
    insert into public.customers (full_name, phone, company_name)
    values (p_contact_name, p_contact_phone, p_company_name)
    returning id into v_customer_id;
  end if;

  insert into public.bookings (
    customer_id, dumpster_id, size_requested, delivery_address,
    delivery_date, pickup_date, status, placement_notes, debris_type,
    subtotal, tax, total, docusign_status, job_tags
  ) values (
    v_customer_id, null, p_size, btrim(p_delivery_address),
    p_delivery_date, v_pickup_date, 'confirmed', p_placement_notes, p_debris_type,
    v_quote.subtotal, v_quote.tax, v_quote.total, 'pending',
    public.infer_job_tags(p_debris_type)
  )
  returning id into v_booking_id;

  insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
  values (v_booking_id, 'delivery', null, p_delivery_date, 'unassigned')
  returning id into v_delivery_job_id;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
  values
    ('booking', v_booking_id,      null, 'confirmed',  p_profile_id),
    ('job',     v_delivery_job_id, null, 'unassigned', p_profile_id);

  return v_booking_id;
end;
$$;

-- =============================================================================
-- check_job_assignment
-- =============================================================================
create or replace function public.check_job_assignment(
  p_job_id    uuid,
  p_driver_id uuid
)
returns table (
  allowed           boolean,
  requires_override boolean,
  truck_id          uuid,
  truck_nickname    text,
  blockers          jsonb,
  warnings          jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_job      record;
  v_company  text;
  v_driver   record;
  v_truck    record;
  v_blockers jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  r          record;
  v_hit      boolean;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select j.type, j.status as job_status, b.id as booking_id, b.size_requested,
         b.debris_type, b.job_tags, b.job_tags_confirmed_at, b.customer_id
    into v_job
  from public.jobs j
  join public.bookings b on b.id = j.booking_id
  where j.id = p_job_id;
  if not found then
    raise exception 'Job % not found', p_job_id using errcode = 'P0002';
  end if;

  select company_name into v_company from public.customers where id = v_job.customer_id;

  select * into v_driver from public.drivers where id = p_driver_id;
  if not found then
    return query select false, false, null::uuid, null::text,
      jsonb_build_array(jsonb_build_object('kind','driver_not_found')), '[]'::jsonb;
    return;
  end if;
  if not v_driver.active then
    v_blockers := v_blockers || jsonb_build_object(
      'kind','driver_inactive','detail', v_driver.full_name || ' is inactive');
  end if;

  select * into v_truck
  from public.trucks
  where assigned_driver_id = p_driver_id and status = 'active';
  if not found then
    v_blockers := v_blockers || jsonb_build_object(
      'kind','no_truck','detail','Driver has no active truck assigned');
    return query select false, false, null::uuid, null::text, v_blockers, '[]'::jsonb;
    return;
  end if;

  -- (a) hard capacity
  if not (v_job.size_requested = any(v_truck.allowed_sizes)) then
    v_blockers := v_blockers || jsonb_build_object(
      'kind','size_not_allowed',
      'detail', v_truck.nickname || ' cannot carry ' || v_job.size_requested::text);
  end if;

  -- (b) restrictions
  for r in select * from public.truck_restrictions where truck_id = v_truck.id loop
    v_hit := false;
    if r.dimension = 'customer' and v_company is not null then
      v_hit := case r.match_mode
        when 'exact' then lower(v_company) = lower(r.match_value)
        else v_company ilike '%' || r.match_value || '%'
      end;
    elsif r.dimension = 'debris_type' and v_job.debris_type is not null then
      v_hit := case r.match_mode
        when 'exact' then lower(v_job.debris_type) = lower(r.match_value)
        else v_job.debris_type ilike '%' || r.match_value || '%'
      end;
    elsif r.dimension = 'job_tag' then
      v_hit := case r.match_mode
        when 'exact' then r.match_value = any(v_job.job_tags)
        else exists (select 1 from unnest(v_job.job_tags) t where t ilike '%' || r.match_value || '%')
      end;
    end if;

    if v_hit then
      if r.enforcement = 'block' then
        v_blockers := v_blockers || jsonb_build_object(
          'kind','restriction','dimension',r.dimension,
          'match_value',r.match_value,'source_phrase',r.source_phrase);
      else
        v_warnings := v_warnings || jsonb_build_object(
          'kind','restriction','dimension',r.dimension,
          'match_value',r.match_value,'source_phrase',r.source_phrase);
      end if;
    end if;
  end loop;

  -- (c) untagged-review: truck has job_tag block rules AND tags not reviewed
  if v_job.job_tags_confirmed_at is null
     and exists (
       select 1 from public.truck_restrictions
       where truck_id = v_truck.id and dimension = 'job_tag' and enforcement = 'block'
     ) then
    v_warnings := v_warnings || jsonb_build_object(
      'kind','untagged_review',
      'detail','Job tags have not been reviewed. Confirm tags before assigning to '
               || v_truck.nickname || '.');
  end if;

  return query select
    (jsonb_array_length(v_blockers) = 0),
    (jsonb_array_length(v_blockers) = 0 and jsonb_array_length(v_warnings) > 0),
    v_truck.id, v_truck.nickname, v_blockers, v_warnings;
end;
$$;

grant execute on function public.check_job_assignment(uuid, uuid) to authenticated;

-- =============================================================================
-- assign_unit / clear_unit
-- =============================================================================
create or replace function public.assign_unit(
  p_booking_id  uuid,
  p_dumpster_id uuid
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_dump    record;
  v_old_status public.dumpster_status;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  if v_booking.status not in ('confirmed', 'delivered', 'active') then
    raise exception 'Cannot assign a unit to a % booking', v_booking.status
      using errcode = '23514';
  end if;

  if v_booking.dumpster_id = p_dumpster_id then
    return v_booking;  -- no-op
  end if;

  select id, size, status into v_dump from public.dumpsters where id = p_dumpster_id;
  if not found then
    raise exception 'Dumpster % not found', p_dumpster_id using errcode = 'P0002';
  end if;
  if v_dump.size <> v_booking.size_requested then
    raise exception 'Unit is a %, booking needs a %', v_dump.size, v_booking.size_requested
      using errcode = '23514';
  end if;
  if v_dump.status <> 'available' then
    raise exception 'Unit is % (not available)', v_dump.status using errcode = '23514';
  end if;

  -- free a previously-reserved unit (cannot swap once deployed)
  if v_booking.dumpster_id is not null then
    select status into v_old_status from public.dumpsters where id = v_booking.dumpster_id;
    if v_old_status = 'reserved' then
      perform public._apply_dumpster_status(v_booking.dumpster_id, 'available', auth.uid());
    elsif v_old_status <> 'available' then
      raise exception 'Current unit is % — cannot swap', v_old_status using errcode = '23514';
    end if;
  end if;

  update public.bookings set dumpster_id = p_dumpster_id where id = p_booking_id
  returning * into v_booking;

  perform public._apply_dumpster_status(p_dumpster_id, 'reserved', auth.uid());

  return v_booking;
end;
$$;

create or replace function public.clear_unit(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_status  public.dumpster_status;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  if v_booking.dumpster_id is null then
    return v_booking;
  end if;

  select status into v_status from public.dumpsters where id = v_booking.dumpster_id;
  if v_status = 'deployed' then
    raise exception 'Unit is deployed — cannot clear' using errcode = '23514';
  end if;
  if v_status = 'reserved' then
    perform public._apply_dumpster_status(v_booking.dumpster_id, 'available', auth.uid());
  end if;

  update public.bookings set dumpster_id = null where id = p_booking_id
  returning * into v_booking;
  return v_booking;
end;
$$;

grant execute on function public.assign_unit(uuid, uuid) to authenticated;
grant execute on function public.clear_unit(uuid) to authenticated;

-- =============================================================================
-- assign_job / unassign_job
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
  v_job     public.jobs;
  v_booking public.bookings;
  v_check   record;
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

  -- unit assignment for delivery jobs
  if v_job.type = 'delivery' and p_dumpster_id is not null then
    perform public.assign_unit(v_job.booking_id, p_dumpster_id);
  end if;

  select full_name into v_driver_name from public.drivers where id = p_driver_id;

  update public.jobs
  set driver_id = p_driver_id, status = 'assigned'
  where id = p_job_id
  returning * into v_job;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by, note)
  values ('job', p_job_id, v_job.status::text, 'assigned', auth.uid(),
          'assigned to ' || coalesce(v_driver_name, p_driver_id::text)
          || case when p_override then ' (override)' else '' end);

  return v_job;
end;
$$;

create or replace function public.unassign_job(p_job_id uuid)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.jobs;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job % not found', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status <> 'assigned' then
    raise exception 'Job is % — nothing to unassign', v_job.status using errcode = '23514';
  end if;

  update public.jobs
  set driver_id = null, status = 'unassigned'
  where id = p_job_id
  returning * into v_job;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by, note)
  values ('job', p_job_id, 'assigned', 'unassigned', auth.uid(), 'driver removed');

  return v_job;
end;
$$;

grant execute on function public.assign_job(uuid, uuid, uuid, boolean) to authenticated;
grant execute on function public.unassign_job(uuid) to authenticated;

-- =============================================================================
-- set_route_order
-- =============================================================================
create or replace function public.set_route_order(
  p_driver_id uuid,
  p_date      date,
  p_job_ids   uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  i integer;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  for i in 1 .. coalesce(array_length(p_job_ids, 1), 0) loop
    update public.jobs
    set route_order = i
    where id = p_job_ids[i]
      and driver_id = p_driver_id
      and scheduled_date = p_date;
  end loop;
end;
$$;

grant execute on function public.set_route_order(uuid, date, uuid[]) to authenticated;

-- =============================================================================
-- confirm_job_tags
-- =============================================================================
create or replace function public.confirm_job_tags(
  p_booking_id uuid,
  p_tags       text[]
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  update public.bookings
  set job_tags = coalesce(p_tags, '{}'::text[]),
      job_tags_confirmed_at = now()
  where id = p_booking_id
  returning * into v_booking;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  return v_booking;
end;
$$;

grant execute on function public.confirm_job_tags(uuid, text[]) to authenticated;

-- =============================================================================
-- complete_job — driver (own job) or staff
-- =============================================================================
create or replace function public.complete_job(p_job_id uuid)
returns public.jobs
language plpgsql
security definer
set search_path = public
as $$
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
      where d.id = v_job.driver_id and d.profile_id = auth.uid()
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
$$;

grant execute on function public.complete_job(uuid) to authenticated;
