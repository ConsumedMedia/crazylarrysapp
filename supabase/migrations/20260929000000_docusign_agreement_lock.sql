-- =============================================================================
-- Crazy Larry's Dumpsters — lock online checkout behind a DocuSign-verified
-- rental agreement
-- =============================================================================
-- Before: the wizard showed the PowerForm in an iframe with a self-attest
-- checkbox, and payAndBookAction trusted `agreementAcknowledged: true` from
-- the browser. Now the server creates one envelope per agreement session from
-- the PowerForm's template (embedded signer = the wizard's name + email,
-- clientUserId = agreement_sessions.id), verifies completion directly with
-- DocuSign when the signer returns, and create_booking consumes the verified
-- session inside the booking transaction.
--
-- agreement_sessions — one row per online "sign the agreement" attempt.
--   * server-only: RLS on, no policies, no anon/authenticated grants (tables
--     are private by default since 20260924010000; nothing is granted here).
--   * envelope_id unique; consumed_booking_id unique -> one completed
--     envelope unlocks exactly one booking.
--   * expires_at = created + 2 days, matching the DocuSign envelope expiry;
--     the daily cron voids still-unsigned envelopes past their window.
--
-- create_booking gains p_agreement_session_id (default null). Online checkout
-- (payAndBook) always passes it and refuses to charge without a verified
-- session; the DB re-checks under the per-size lock and consumes it. Null is
-- the staff-manual / demo-seed path, which keeps docusign_status 'pending' and
-- the existing manual "mark agreement signed" flow.
--
-- Function-grant note: create_booking/_create_booking_core are DROPPED and
-- recreated (new parameter = new signature), so under 20260924000000 they are
-- private until granted — create_booking is granted to service_role below.
-- staff_create_booking keeps its signature (CREATE OR REPLACE keeps grants).
-- =============================================================================

create table public.agreement_sessions (
  id                  uuid primary key default gen_random_uuid(),
  envelope_id         text unique,
  signer_name         text not null,
  signer_email        text not null check (signer_email = lower(btrim(signer_email))),
  status              text not null default 'created'
    check (status in ('created', 'sent', 'completed', 'declined', 'voided', 'expired', 'error')),
  completed_at        timestamptz,          -- DocuSign completedDateTime
  verified_at         timestamptz,          -- when OUR server confirmed completion with DocuSign
  last_checked_at     timestamptz,
  check_count         integer not null default 0,
  consumed_booking_id uuid unique references public.bookings (id) on delete set null,
  consumed_at         timestamptz,
  expires_at          timestamptz not null default now() + interval '2 days',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index agreement_sessions_open_idx on public.agreement_sessions (created_at)
  where status in ('created', 'sent');
create index agreement_sessions_email_created_idx on public.agreement_sessions (signer_email, created_at desc);

alter table public.agreement_sessions enable row level security;  -- also auto-enabled by rls_auto_enable
-- Intentionally no policies and no grants: service_role only.

alter table public.bookings
  add column docusign_envelope_id  text unique,
  add column docusign_completed_at timestamptz;

-- -----------------------------------------------------------------------------
-- Booking core + wrappers
-- -----------------------------------------------------------------------------
drop function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean
);
drop function public._create_booking_core(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text,
  uuid, boolean, uuid, text, uuid
);

create or replace function public._create_booking_core(
  p_size                public.dumpster_size,
  p_delivery_date       date,
  p_delivery_address    text,
  p_contact_name        text,
  p_rental_days         integer,
  p_placement_notes     text,
  p_debris_type         text,
  p_contact_email       text,
  p_contact_phone       text,
  p_company_name        text,
  p_customer_profile_id uuid,     -- links the customer row to a login
  p_sms_consent         boolean,
  p_actor_id            uuid,     -- status_log.changed_by / bookings.created_by
  p_source              text,     -- 'online' | 'staff'
  p_customer_id         uuid,     -- staff picked an existing customer
  p_agreement_session_id uuid     -- online checkout: verified DocuSign agreement (null = staff/seed path)
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
  v_sms_consent     boolean := coalesce(p_sms_consent, false);
  v_agreement       public.agreement_sessions;
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
  if p_source not in ('online', 'staff') then
    raise exception 'bad source' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cl_booking:' || p_size::text));

  -- Online checkout: the agreement must be DocuSign-verified complete, signed
  -- by this booking's email, unexpired, and not already used. Locked FOR
  -- UPDATE and consumed below in this same transaction, so one completed
  -- envelope can unlock exactly one booking even under concurrent checkouts.
  if p_agreement_session_id is not null then
    select * into v_agreement from public.agreement_sessions
      where id = p_agreement_session_id for update;
    if not found then
      raise exception 'Rental agreement not found' using errcode = 'P0001', hint = 'agreement_missing';
    end if;
    if v_agreement.status <> 'completed' or v_agreement.verified_at is null then
      raise exception 'Rental agreement is not signed' using errcode = 'P0001', hint = 'agreement_incomplete';
    end if;
    if v_agreement.consumed_booking_id is not null then
      raise exception 'Rental agreement was already used for another booking' using errcode = 'P0001', hint = 'agreement_used';
    end if;
    if v_agreement.expires_at < now() then
      raise exception 'Rental agreement session expired' using errcode = 'P0001', hint = 'agreement_expired';
    end if;
    if p_contact_email is null or lower(btrim(p_contact_email)) <> lower(v_agreement.signer_email) then
      raise exception 'Rental agreement was signed with a different email' using errcode = 'P0001', hint = 'agreement_email_mismatch';
    end if;
  end if;

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

  v_pickup_date := p_delivery_date + p_rental_days;

  if p_customer_id is not null then
    -- Staff picked an existing customer: keep their identity, fill gaps.
    update public.customers set
      full_name    = p_contact_name,
      email        = coalesce(p_contact_email, email),
      phone        = coalesce(p_contact_phone, phone),
      company_name = coalesce(p_company_name, company_name),
      sms_consent  = v_sms_consent
    where id = p_customer_id
    returning id into v_customer_id;
    if v_customer_id is null then
      raise exception 'Customer % not found', p_customer_id using errcode = 'P0002';
    end if;
  elsif p_customer_profile_id is not null then
    select id into v_customer_id from public.customers where profile_id = p_customer_profile_id;
    if v_customer_id is null then
      insert into public.customers (profile_id, full_name, email, phone, company_name, sms_consent)
      values (p_customer_profile_id, p_contact_name, p_contact_email, p_contact_phone, p_company_name, v_sms_consent)
      returning id into v_customer_id;
    else
      update public.customers set
        full_name = p_contact_name,
        email = coalesce(p_contact_email, email),
        phone = coalesce(p_contact_phone, phone),
        company_name = coalesce(p_company_name, company_name),
        sms_consent = v_sms_consent
      where id = v_customer_id;
    end if;
  elsif p_contact_email is not null then
    -- Online guests only ever match other guest rows (a guest typing someone
    -- else's email must not attach to that person's account). Staff are
    -- trusted to have confirmed identity on the call, so a staff booking also
    -- matches a registered customer with that email — preferring them, so
    -- the booking shows up in their portal.
    select id into v_customer_id
    from public.customers
    where lower(email) = lower(p_contact_email)
      and (profile_id is null or p_source = 'staff')
    order by (profile_id is not null) desc, created_at asc
    limit 1;
    if v_customer_id is null then
      insert into public.customers (full_name, email, phone, company_name, sms_consent)
      values (p_contact_name, p_contact_email, p_contact_phone, p_company_name, v_sms_consent)
      returning id into v_customer_id;
    else
      update public.customers set
        full_name = p_contact_name,
        phone = coalesce(p_contact_phone, phone),
        company_name = coalesce(p_company_name, company_name),
        sms_consent = v_sms_consent
      where id = v_customer_id;
    end if;
  else
    insert into public.customers (full_name, phone, company_name, sms_consent)
    values (p_contact_name, p_contact_phone, p_company_name, v_sms_consent)
    returning id into v_customer_id;
  end if;

  insert into public.bookings (
    customer_id, dumpster_id, size_requested, delivery_address,
    delivery_date, pickup_date, status, placement_notes, debris_type,
    subtotal, tax, total, docusign_status, job_tags, source, created_by,
    docusign_envelope_id, docusign_completed_at
  ) values (
    v_customer_id, null, p_size, btrim(p_delivery_address),
    p_delivery_date, v_pickup_date, 'confirmed', p_placement_notes, p_debris_type,
    v_quote.subtotal, v_quote.tax, v_quote.total,
    case when p_agreement_session_id is not null then 'signed'::public.docusign_status else 'pending'::public.docusign_status end,
    public.infer_job_tags(p_debris_type), p_source, p_actor_id,
    v_agreement.envelope_id, v_agreement.completed_at
  )
  returning id into v_booking_id;

  if p_agreement_session_id is not null then
    update public.agreement_sessions
      set consumed_booking_id = v_booking_id, consumed_at = now(), updated_at = now()
      where id = p_agreement_session_id;
  end if;

  insert into public.jobs (booking_id, type, driver_id, scheduled_date, status)
  values (v_booking_id, 'delivery', null, p_delivery_date, 'unassigned')
  returning id into v_delivery_job_id;

  insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
  values
    ('booking', v_booking_id,      null, 'confirmed',  p_actor_id),
    ('job',     v_delivery_job_id, null, 'unassigned', p_actor_id);

  return v_booking_id;
end;
$$;

create or replace function public.create_booking(
  p_size                 public.dumpster_size,
  p_delivery_date        date,
  p_delivery_address     text,
  p_contact_name         text,
  p_rental_days          integer default 5,
  p_placement_notes      text default null,
  p_debris_type          text default null,
  p_contact_email        text default null,
  p_contact_phone        text default null,
  p_company_name         text default null,
  p_profile_id           uuid default null,
  p_sms_consent          boolean default false,
  p_agreement_session_id uuid default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public._create_booking_core(
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
$$;

-- staff path: same signature as before, never carries an agreement session.
create or replace function public.staff_create_booking(
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
  p_sms_consent      boolean default false,
  p_customer_id      uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may create bookings directly'
      using errcode = '42501';
  end if;

  return public._create_booking_core(
    p_size, p_delivery_date, p_delivery_address, p_contact_name, p_rental_days,
    p_placement_notes, p_debris_type, p_contact_email, p_contact_phone,
    p_company_name,
    null,          -- never link the phone customer to the staff login
    p_sms_consent,
    auth.uid(),    -- the staff member, for status_log + bookings.created_by
    'staff',
    p_customer_id,
    null           -- staff bookings keep the manual agreement flow
  );
end;
$$;

-- Explicit grants (functions are private by default since 20260924000000).
revoke execute on function public._create_booking_core(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text,
  uuid, boolean, uuid, text, uuid, uuid
) from public, anon, authenticated;
revoke execute on function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean, uuid
) to service_role;
