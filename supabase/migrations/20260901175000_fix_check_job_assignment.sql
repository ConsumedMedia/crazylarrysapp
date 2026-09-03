-- =============================================================================
-- Fix: check_job_assignment — "truck_id" ambiguous between the OUT parameter
-- and truck_restrictions.truck_id. Qualify the column references.
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
  from public.trucks t
  where t.assigned_driver_id = p_driver_id and t.status = 'active';
  if not found then
    v_blockers := v_blockers || jsonb_build_object(
      'kind','no_truck','detail','Driver has no active truck assigned');
    return query select false, false, null::uuid, null::text, v_blockers, '[]'::jsonb;
    return;
  end if;

  if not (v_job.size_requested = any(v_truck.allowed_sizes)) then
    v_blockers := v_blockers || jsonb_build_object(
      'kind','size_not_allowed',
      'detail', v_truck.nickname || ' cannot carry ' || v_job.size_requested::text);
  end if;

  for r in
    select * from public.truck_restrictions tr where tr.truck_id = v_truck.id
  loop
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
        else exists (select 1 from unnest(v_job.job_tags) tg where tg ilike '%' || r.match_value || '%')
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

  if v_job.job_tags_confirmed_at is null
     and exists (
       select 1 from public.truck_restrictions tr
       where tr.truck_id = v_truck.id and tr.dimension = 'job_tag' and tr.enforcement = 'block'
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
