-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 4: booking engine
-- =============================================================================
--   * booking_transition_allowed / set_booking_status  — lifecycle state machine
--   * booking_quote                                     — server-authoritative money
--   * create_booking                                    — the atomic creation RPC
--   * set_booking_docusign_status                       — manual agreement advance
--   * mark_overdue_bookings                             — daily date-based sweep
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Lifecycle state machine
-- -----------------------------------------------------------------------------
--   confirmed        -> delivered
--   delivered        -> active
--   active           -> pickup_scheduled | overdue
--   pickup_scheduled -> returned | overdue
--   overdue          -> pickup_scheduled | returned
--   *                -> cancelled            (staff, any point before returned)
--   returned / cancelled are terminal. No-op (x -> x) is not a transition.
create or replace function public.booking_transition_allowed(
  p_from public.booking_status,
  p_to   public.booking_status
)
returns boolean
language sql
immutable
as $$
  select case
    when p_from = p_to then false
    when p_to = 'cancelled' then p_from not in ('returned', 'cancelled')
    when p_from = 'confirmed'        then p_to = 'delivered'
    when p_from = 'delivered'        then p_to = 'active'
    when p_from = 'active'           then p_to in ('pickup_scheduled', 'overdue')
    when p_from = 'pickup_scheduled' then p_to in ('returned', 'overdue')
    when p_from = 'overdue'          then p_to in ('pickup_scheduled', 'returned')
    else false
  end;
$$;

-- -----------------------------------------------------------------------------
-- booking_quote — the only source of the money on a booking
-- -----------------------------------------------------------------------------
-- Raises (hint 'pricing_not_configured' / 'tax_not_configured') until staff
-- have entered real rates. subtotal = the size's flat base_price for the
-- standard rental; overage weight and extra days are billed later (Phase 5).
create or replace function public.booking_quote(p_size public.dumpster_size)
returns table (subtotal numeric, tax numeric, total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base     numeric(10, 2);
  v_active   boolean;
  v_tax_rate numeric(6, 4);
begin
  select base_price, is_active into v_base, v_active
  from public.cl_pricing where size = p_size;

  select tax_rate into v_tax_rate
  from public.cl_pricing_settings where id = true;

  if v_base is null or not v_active or v_base <= 0 then
    raise exception 'Pricing for % is not configured', p_size
      using errcode = 'P0001', hint = 'pricing_not_configured';
  end if;
  if v_tax_rate is null or v_tax_rate <= 0 then
    raise exception 'Sales tax rate is not configured'
      using errcode = 'P0001', hint = 'tax_not_configured';
  end if;

  subtotal := v_base;
  tax      := round(v_base * v_tax_rate, 2);
  total    := subtotal + tax;
  return next;
end;
$$;

-- -----------------------------------------------------------------------------
-- create_booking — ATOMIC: customer + booking + delivery job, all or nothing
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER: guest checkout has no auth session and the target tables
-- are staff-only under RLS. Reachable only through the server action, which
-- calls it with the service-role key. p_profile_id is set by that action from
-- the server-verified session (never a form field).
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
  v_customer_id uuid;
  v_pickup_date date;
  v_quote       record;
  v_avail       record;
  v_booking_id  uuid;
begin
  -- ---- input sanity (server action validates too; defense in depth) --------
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

  -- ---- 1. serialize booking creation per size ------------------------------
  perform pg_advisory_xact_lock(hashtext('cl_booking:' || p_size::text));

  -- ---- 2. pricing gate + authoritative quote (raises if unconfigured) -----
  select * into v_quote from public.booking_quote(p_size);

  -- ---- 3. final server-side availability re-check (never trust client) ----
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

  -- ---- 4. resolve the customer -------------------------------------------
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

  -- ---- 5. the booking ---------------------------------------------------
  -- dumpster_id stays NULL: size-level commitment now, unit assignment at
  -- dispatch. TODO(phase-6): assign dumpster_id then.
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

  -- ---- 6. delivery job (pickup job created on -> pickup_scheduled) -------
  insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
  values (v_booking_id, 'delivery', null, p_delivery_date, 'unassigned');

  -- ---- 7. opening status_log row --------------------------------------
  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
  values ('booking', v_booking_id, null, 'confirmed', p_profile_id);

  return v_booking_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- set_booking_status — lifecycle transitions + cancellation cascade
-- -----------------------------------------------------------------------------
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
  v_old public.booking_status;
  v_row public.bookings;
  j     record;
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

  -- TODO(phase-6): on 'pickup_scheduled' create the pickup job;
  --   on 'delivered' complete the delivery job (+ assigned unit -> deployed);
  --   on 'returned' complete the pickup job (+ assigned unit -> available).

  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- set_booking_docusign_status — manual agreement advance (no live DocuSign API)
-- -----------------------------------------------------------------------------
create or replace function public.set_booking_docusign_status(
  p_booking_id uuid,
  p_to         public.docusign_status
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.bookings;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may change agreement status'
      using errcode = '42501';
  end if;

  update public.bookings set docusign_status = p_to
  where id = p_booking_id
  returning * into v_row;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- mark_overdue_bookings — daily date-based sweep (cron wires this later)
-- -----------------------------------------------------------------------------
create or replace function public.mark_overdue_bookings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  b       record;
begin
  for b in
    select id, status from public.bookings
    where status in ('active', 'pickup_scheduled')
      and pickup_date is not null
      and pickup_date < current_date
    for update
  loop
    update public.bookings set status = 'overdue' where id = b.id;
    insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
    values ('booking', b.id, b.status::text, 'overdue', null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant execute on function public.booking_transition_allowed(public.booking_status, public.booking_status) to authenticated;
grant execute on function public.booking_quote(public.dumpster_size) to authenticated, service_role;
grant execute on function public.create_booking(public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid) to service_role;
grant execute on function public.set_booking_status(uuid, public.booking_status) to authenticated;
grant execute on function public.set_booking_docusign_status(uuid, public.docusign_status) to authenticated;
grant execute on function public.mark_overdue_bookings() to service_role;
