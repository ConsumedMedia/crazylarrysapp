-- =============================================================================
-- Crazy Larry's Dumpsters — audit parity: log the delivery job on creation
-- =============================================================================
-- create_booking wrote a status_log row for the booking but not for the
-- delivery job it creates. The pickup_scheduled branch (20260901120000) logs
-- its job; this brings create_booking's delivery job to the same standard:
--   status_log('job', <delivery job id>, NULL -> 'unassigned', p_profile_id)
--
-- Pure addition — everything else in create_booking is unchanged.

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

  -- ---- resolve the customer ----------------------------------------------
  if p_profile_id is not null then
    select id into v_customer_id
    from public.customers where profile_id = p_profile_id;

    if v_customer_id is null then
      insert into public.customers (profile_id, full_name, email, phone, company_name)
      values (p_profile_id, p_contact_name, p_contact_email, p_contact_phone, p_company_name)
      returning id into v_customer_id;
    else
      update public.customers set
        full_name    = p_contact_name,
        email        = coalesce(p_contact_email, email),
        phone        = coalesce(p_contact_phone, phone),
        company_name = coalesce(p_company_name, company_name)
      where id = v_customer_id;
    end if;

  elsif p_contact_email is not null then
    select id into v_customer_id
    from public.customers
    where profile_id is null and lower(email) = lower(p_contact_email)
    order by created_at asc
    limit 1;

    if v_customer_id is null then
      insert into public.customers (full_name, email, phone, company_name)
      values (p_contact_name, p_contact_email, p_contact_phone, p_company_name)
      returning id into v_customer_id;
    else
      update public.customers set
        full_name    = p_contact_name,
        phone        = coalesce(p_contact_phone, phone),
        company_name = coalesce(p_company_name, company_name)
      where id = v_customer_id;
    end if;

  else
    insert into public.customers (full_name, phone, company_name)
    values (p_contact_name, p_contact_phone, p_company_name)
    returning id into v_customer_id;
  end if;

  -- ---- the booking (dumpster_id NULL: unit assigned at dispatch) ---------
  insert into public.bookings (
    customer_id, dumpster_id, size_requested, delivery_address,
    delivery_date, pickup_date, status, placement_notes, debris_type,
    subtotal, tax, total, docusign_status
  ) values (
    v_customer_id, null, p_size, btrim(p_delivery_address),
    p_delivery_date, v_pickup_date, 'confirmed', p_placement_notes, p_debris_type,
    v_quote.subtotal, v_quote.tax, v_quote.total, 'pending'
  )
  returning id into v_booking_id;

  -- ---- delivery job (pickup job created on -> pickup_scheduled) ----------
  insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
  values (v_booking_id, 'delivery', null, p_delivery_date, 'unassigned')
  returning id into v_delivery_job_id;

  -- ---- opening status_log rows: booking + its delivery job --------------
  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
  values
    ('booking', v_booking_id,      null, 'confirmed',  p_profile_id),
    ('job',     v_delivery_job_id, null, 'unassigned', p_profile_id);

  return v_booking_id;
end;
$$;
