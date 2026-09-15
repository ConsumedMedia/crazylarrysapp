-- =============================================================================
-- Crazy Larry's Dumpsters — pickup date = delivery + rental_days (was -1)
-- =============================================================================
-- Client framing: the "5 days" a customer is quoted are the days AFTER
-- delivery — the delivery day itself doesn't count as one of the 5. So a
-- standard rental now spans delivery_date .. delivery_date + rental_days
-- (6 calendar days for the default 5), not delivery_date .. delivery_date +
-- (rental_days - 1) (5 calendar days) as it did before. The "N days" wording
-- shown to customers is unchanged — only the date math moves.
--
-- Two functions change, both by the same one-line formula swap:
--   * create_booking       — the actual pickup_date written to a booking
--   * size_availability    — the commitment/blocked window a size occupies
-- They must move together: size_availability's window is what create_booking
-- itself checks before writing dates (via its own call to size_availability),
-- and it's what the customer-facing calendar uses to show occupied days. If
-- only one changed, a booking could be created for a day the calendar/RPC
-- still reported as free under the old (shorter) window, or vice versa.
--
-- bookings_no_overlap_per_dumpster (the exclusion constraint) needs NO
-- change: it reads delivery_date/pickup_date directly off the bookings row
-- (`daterange(delivery_date, pickup_date, '[]')`), with no day-count formula
-- of its own. Whatever create_booking now writes, the constraint enforces —
-- automatically, with no migration required. Confirmed by re-reading
-- 20260901010000 and 20260901060000: neither references rental_days or any
-- day-count constant.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- create_booking — same body as 20260901170000, one line changed (v_pickup_date)
-- -----------------------------------------------------------------------------
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

  -- CHANGED: was `p_delivery_date + (p_rental_days - 1)`. The delivery day no
  -- longer counts as one of the rental_days; pickup is rental_days AFTER it.
  v_pickup_date := p_delivery_date + p_rental_days;

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

-- -----------------------------------------------------------------------------
-- size_availability — same body as 20260901070000, two occurrences changed
-- -----------------------------------------------------------------------------
create or replace function public.size_availability(
  p_size        public.dumpster_size,
  p_from        date,
  p_to          date,
  p_rental_days integer default 5
)
returns table (
  day       date,
  total     integer,
  committed integer,
  blocked   boolean,
  is_past   boolean
)
language sql
stable
security definer
set search_path = public
as $$
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
        -- CHANGED: was `days.day + (p_rental_days - 1)`.
        and daterange(b.delivery_date, b.pickup_date, '[]')
          && daterange(days.day, days.day + p_rental_days, '[]')
    ) as committed,
    exists (
      select 1
      from public.calendar_blocks cb
      where (cb.size = p_size or cb.size is null)
        and (
          daterange(cb.start_date, cb.end_date, '[]') @> days.day
          -- CHANGED: was `days.day + (p_rental_days - 1)`.
          or daterange(cb.start_date, cb.end_date, '[]')
               @> (days.day + p_rental_days)
        )
    ) as blocked,
    (days.day < current_date + 1) as is_past
  from days
  cross join fleet
  order by days.day;
$$;

comment on function public.size_availability(public.dumpster_size, date, date, integer)
  is 'Live per-day availability for a dumpster size over a date range. Window is [day, day + rental_days] — pickup day inclusive, delivery day not counted as one of the rental_days. See migration 20260915000000 (supersedes 20260901070000''s window formula).';
