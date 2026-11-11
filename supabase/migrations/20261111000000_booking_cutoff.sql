-- =============================================================================
-- Crazy Larry's Dumpsters — order cutoff for online and pay-link bookings
-- =============================================================================
-- An owner-set time of day (America/New_York). While the cutoff is ON and the
-- yard's clock has reached it, an ONLINE booking (create_booking) or a
-- PAY-LINK booking (staff_create_pay_link_booking) can't take tomorrow as the
-- delivery day: the earliest becomes the day after tomorrow. Staff phone
-- bookings (staff_create_booking) keep today's rule: tomorrow or later.
--
-- Ships OFF. With it off, every path behaves exactly as before.
--
-- 1. cl_booking_settings: singleton row, like cl_pay_link_settings.
--      cutoff_enabled  default false
--      cutoff_time     default 15:00; 03:00–23:45 in 15-minute steps. Daylight
--                      saving changes happen at 2 AM, so a cutoff of 3 AM or
--                      later is never in a skipped or repeated hour.
--    Staff read; owners update the two settings columns only. No insert or
--    delete for anyone but the owner role (postgres) and service_role.
-- 2. booking_delivery_floor(p_now), SECURITY DEFINER, service_role only:
--    the earliest delivery day per channel,
--    whether the cutoff has passed, and when the floor next changes. The one
--    place the rule lives: the calendar API and checkout's early check call it
--    too (service_role). Settings missing or unreadable → off → tomorrow.
-- 3. _assert_online_delivery_floor(date): refuses a date the cutoff closed,
--    judged as of 10 minutes ago (grace). The floor only ever moves later, so
--    a checkout the app approved at time t still passes here up to t + 10
--    minutes: the database never refuses, after the charge, a day the app
--    let through before it. Dates before tomorrow are left to the core's
--    existing "tomorrow or later" refusal.
-- 4. _booking_clock(): now(). Lets the rolled-back probe fake the clock.
--    It and the assert are executable by the owner only: the wrappers run as
--    the owner; no API role needs either.
-- 5. create_booking (online) and staff_create_pay_link_booking call the
--    assert before anything else is touched (no agreement session consumed,
--    no pay link issued). Same signatures and grants; rebuilt from the LIVE
--    definitions (create_booking is main's 13-argument DocuSign version,
--    md5 96232bfd70e9c467ba2d3b794405bcbc; staff_create_pay_link_booking md5
--    140c6369182c6cada3dd689618bf09d8, both read 2026-11-11).
--
-- NOT changed: _create_booking_core, staff_create_booking, size_availability,
-- yard_today. The probe pins their md5s.
-- =============================================================================

create table public.cl_booking_settings (
  id             boolean primary key default true check (id),
  cutoff_enabled boolean not null default false,
  cutoff_time    time not null default '15:00',
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.profiles (id) on delete set null,
  constraint cl_booking_settings_cutoff_time_check check (
    cutoff_time between time '03:00' and time '23:45'
    and extract(second from cutoff_time) = 0
    and (extract(minute from cutoff_time))::int % 15 = 0
  )
);

comment on table public.cl_booking_settings is
  'Singleton. Order cutoff for online and pay-link bookings (America/New_York). Staff phone bookings ignore it.';
comment on column public.cl_booking_settings.cutoff_time is
  'Yard time of day. From this time on, online and pay-link bookings can''t take tomorrow. 03:00–23:45, 15-minute steps.';

insert into public.cl_booking_settings (id) values (true);

alter table public.cl_booking_settings enable row level security;

create policy "cl_booking_settings: staff read" on public.cl_booking_settings
  for select to authenticated using (public.is_staff());
create policy "cl_booking_settings: owner update" on public.cl_booking_settings
  for update to authenticated using (public.is_owner()) with check (public.is_owner());

revoke all on public.cl_booking_settings from public, anon, authenticated;
grant select on public.cl_booking_settings to authenticated;
grant update (cutoff_enabled, cutoff_time) on public.cl_booking_settings to authenticated;

create trigger cl_booking_settings_set_updated_at
  before update on public.cl_booking_settings
  for each row execute function public.set_updated_at();

create function public._stamp_booking_settings()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- A trigger function: nobody calls it. EXECUTE is checked when the trigger is
-- created, not when it fires, so it is revoked from every API role.
revoke all on function public._stamp_booking_settings() from public, anon, authenticated, service_role;

create trigger cl_booking_settings_stamp
  before update on public.cl_booking_settings
  for each row execute function public._stamp_booking_settings();

-- -----------------------------------------------------------------------------
-- booking_delivery_floor
-- -----------------------------------------------------------------------------
create function public.booking_delivery_floor(p_now timestamptz default now())
returns table (
  earliest_online date,
  earliest_staff  date,
  cutoff_enabled  boolean,
  cutoff_time     time,
  after_cutoff    boolean,
  next_change_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- DEFINER: it reads public.yard_today(), which is executable by the owner
  -- only (20261029000000). service_role (the calendar API, checkout) gets this
  -- one date-and-time answer, nothing else.
  with s as (
    select coalesce((select b.cutoff_enabled from public.cl_booking_settings b where b.id), false) as enabled,
           coalesce((select b.cutoff_time from public.cl_booking_settings b where b.id), time '15:00') as t
  ), n as (
    select public.yard_today(p_now) as today,
           (p_now at time zone 'America/New_York')::time as local_time
  )
  select
    n.today + 1 + case when s.enabled and n.local_time >= s.t then 1 else 0 end,
    n.today + 1,
    s.enabled,
    s.t,
    s.enabled and n.local_time >= s.t,
    case when s.enabled and n.local_time < s.t
         then (n.today + s.t) at time zone 'America/New_York'
         else (n.today + 1)::timestamp at time zone 'America/New_York' end
  from s, n
$$;

revoke all on function public.booking_delivery_floor(timestamptz) from public, anon, authenticated;
grant execute on function public.booking_delivery_floor(timestamptz) to service_role;

-- -----------------------------------------------------------------------------
-- _booking_clock — now(); the probe replaces it inside its rolled-back transaction.
-- -----------------------------------------------------------------------------
create function public._booking_clock()
returns timestamptz
language sql
stable
security invoker
set search_path = public
as $$
  select now()
$$;

-- Only the owner-run booking wrappers call it: no API role gets it.
revoke all on function public._booking_clock() from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- _assert_online_delivery_floor
-- -----------------------------------------------------------------------------
create function public._assert_online_delivery_floor(p_delivery_date date)
returns void
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_now   timestamptz := public._booking_clock();
  v_floor record;
begin
  if p_delivery_date is null then
    return;  -- the core refuses a missing date with its own message
  end if;
  select * into v_floor from public.booking_delivery_floor(v_now - interval '10 minutes');
  if p_delivery_date >= public.yard_today(v_now) + 1
     and p_delivery_date < v_floor.earliest_online then
    raise exception 'Delivery date is closed by the % order cutoff; earliest delivery is %',
      to_char(v_floor.cutoff_time, 'HH24:MI'), v_floor.earliest_online
      using errcode = 'P0001', hint = 'after_cutoff';
  end if;
end;
$$;

-- Only the owner-run booking wrappers call it (it reads yard_today, owner-only):
-- no API role gets it.
revoke all on function public._assert_online_delivery_floor(date) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- create_booking — online. Same signature (main's DocuSign version); now
-- plpgsql so the cutoff is checked before the core runs.
-- -----------------------------------------------------------------------------
create or replace function public.create_booking(
  p_size dumpster_size,
  p_delivery_date date,
  p_delivery_address text,
  p_contact_name text,
  p_rental_days integer default 5,
  p_placement_notes text default null::text,
  p_debris_type text default null::text,
  p_contact_email text default null::text,
  p_contact_phone text default null::text,
  p_company_name text default null::text,
  p_profile_id uuid default null::uuid,
  p_sms_consent boolean default false,
  p_agreement_session_id uuid default null::uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Before the core: a refused date never locks or consumes the agreement session.
  perform public._assert_online_delivery_floor(p_delivery_date);

  return public._create_booking_core(
    p_size, p_delivery_date, p_delivery_address, p_contact_name, p_rental_days,
    p_placement_notes, p_debris_type, p_contact_email, p_contact_phone,
    p_company_name,
    p_profile_id,   -- customer login linkage
    p_sms_consent,
    p_profile_id,   -- actor (same person online)
    'online',
    null,
    p_agreement_session_id
  );
end;
$$;

revoke all on function public.create_booking(dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.create_booking(dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- staff_create_pay_link_booking — as live, plus the cutoff check before the
-- core (so a refused date creates no booking and issues no link).
-- -----------------------------------------------------------------------------
create or replace function public.staff_create_pay_link_booking(
  p_size dumpster_size,
  p_delivery_date date,
  p_delivery_address text,
  p_contact_name text,
  p_rental_days integer default 5,
  p_placement_notes text default null::text,
  p_debris_type text default null::text,
  p_contact_email text default null::text,
  p_contact_phone text default null::text,
  p_company_name text default null::text,
  p_verbal_sms_consent boolean default false,
  p_customer_id uuid default null::uuid,
  p_token_key text default null::text
)
returns table(booking_id uuid, token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := nullif(btrim(p_contact_email), '');
  v_phone      text := nullif(btrim(p_contact_phone), '');
  v_consent    boolean := coalesce(p_verbal_sms_consent, false);
  v_booking_id uuid;
  v_customer   uuid;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may create bookings directly'
      using errcode = '42501';
  end if;
  if not coalesce((select enabled from public.cl_pay_link_settings where id), false) then
    raise exception 'Pay links are turned off in Settings'
      using errcode = '23514', hint = 'pay_links_disabled';
  end if;
  if v_email is null and not (v_phone is not null and v_consent) then
    raise exception 'Add an email, or a phone number with the customer''s verbal OK to texts'
      using errcode = '23514', hint = 'no_reachable_contact';
  end if;

  -- The order cutoff applies to pay-link bookings (the customer pays online).
  perform public._assert_online_delivery_floor(p_delivery_date);

  -- The LIVE _create_booking_core is the 16-argument one from main's
  -- 20260929000000_docusign_agreement_lock (its last argument, the online
  -- agreement session, has no default). users-page's own migration files
  -- still show the older 15-argument version; the database is what counts.
  v_booking_id := public._create_booking_core(
    p_size, p_delivery_date, p_delivery_address, p_contact_name, p_rental_days,
    p_placement_notes, p_debris_type, v_email, v_phone, p_company_name,
    null,          -- never link the phone customer to the staff login
    v_consent,
    auth.uid(),    -- the staff member, for status_log + bookings.created_by
    'staff',
    p_customer_id,
    null           -- no DocuSign agreement session on the staff path
  );

  select b.customer_id into v_customer from public.bookings b where b.id = v_booking_id;
  if v_consent then
    insert into public.consent_records
      (customer_id, booking_id, granted, source, recorded_by)
    values (v_customer, v_booking_id, true, 'phone_verbal', auth.uid());
  end if;

  perform public._assert_pay_link_issuable(v_booking_id);
  booking_id := v_booking_id;
  token := public._issue_pay_link(v_booking_id, auth.uid(), p_token_key);
  return next;
end;
$$;

revoke all on function public.staff_create_pay_link_booking(dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid, text) from public, anon;
grant execute on function public.staff_create_pay_link_booking(dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid, text) to authenticated, service_role;
