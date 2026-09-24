-- =============================================================================
-- Crazy Larry's Dumpsters — admin manual bookings (phone / in-person)
-- =============================================================================
-- Staff create a booking with no payment collected at creation; payment is
-- recorded later either by staff (cash/check) or automatically when the
-- customer pays the emailed QuickBooks invoice (detected by the daily sync
-- polling Invoice.Balance — see lib/quickbooks/invoice-payments.ts).
--
-- 1. _create_booking_core — the body of create_booking, unchanged in every
--    respect that matters for double-booking (per-size advisory lock,
--    booking_quote pricing gate, size_availability incl. the tomorrow floor,
--    pickup = delivery + rental_days), with the one conflation it had split
--    apart: p_profile_id used to mean BOTH "link this customer to that login"
--    AND "status_log.changed_by". For a staff-entered booking those are
--    different people (the phone customer vs. the staff member), so they are
--    now two parameters. create_booking keeps its exact signature and passes
--    the same value to both, so the online /book path is byte-for-byte the
--    same behavior.
--
--    Payment was never inside this transaction (payAndBook charges before
--    calling create_booking and compensates with a refund on failure), so the
--    staff path skipping payment removes nothing from the atomic unit.
--
-- 2. staff_create_booking — is_staff() guard, actor = auth.uid(), customer
--    profile always NULL (a later sign-up with the same verified email is
--    linked by the existing claim_guest_bookings()). Called with the staff
--    member's own session, never service_role.
--
-- 3. record_manual_payment — cash/check, staff-only, who/when/method/ref.
-- 4. record_invoice_issued — the QBO invoice with the pay link was sent.
-- 5. record_invoice_payment_detected — the daily sync (or a staff "check
--    now") saw the QBO invoice's Balance hit 0. service_role only.
--
-- Both paid-marking paths update `where payment_status <> 'paid'` under a
-- row lock, so a staff cash entry racing the sync can't double-record.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
alter table public.bookings
  add column source     text not null default 'online'
    check (source in ('online', 'staff')),
  add column created_by uuid references public.profiles (id) on delete set null;

alter table public.invoices
  add column payment_method    text
    check (payment_method is null or payment_method in ('card', 'cash', 'check', 'qbo_invoice')),
  add column payment_reference text,           -- check number, etc.
  add column payment_note      text,
  add column recorded_by       uuid references public.profiles (id) on delete set null,
  add column qb_invoice_link   text,           -- Invoice.InvoiceLink (hosted Pay Now page)
  add column invoice_sent_to   text,
  add column invoice_sent_at   timestamptz,
  add column qb_balance        numeric(10, 2), -- last Invoice.Balance the sync saw
  add column qb_checked_at     timestamptz;

-- Every existing invoices row came from the card checkout.
update public.invoices set payment_method = 'card'
  where payment_method is null and qb_charge_id is not null;

-- Staff "outstanding invoices" lookups + the sync's poll set.
create index invoices_pending_qbo_idx on public.invoices (status)
  where status = 'pending' and quickbooks_invoice_id is not null;

-- -----------------------------------------------------------------------------
-- _create_booking_core
-- -----------------------------------------------------------------------------
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
  p_customer_id         uuid      -- staff picked an existing customer
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
    subtotal, tax, total, docusign_status, job_tags, source, created_by
  ) values (
    v_customer_id, null, p_size, btrim(p_delivery_address),
    p_delivery_date, v_pickup_date, 'confirmed', p_placement_notes, p_debris_type,
    v_quote.subtotal, v_quote.tax, v_quote.total, 'pending',
    public.infer_job_tags(p_debris_type), p_source, p_actor_id
  )
  returning id into v_booking_id;

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

revoke execute on function public._create_booking_core(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text,
  uuid, boolean, uuid, text, uuid
) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- create_booking — same signature, now a thin wrapper (online /book path).
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
  p_profile_id       uuid default null,
  p_sms_consent      boolean default false
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
    null
  );
$$;

revoke execute on function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean
) from public, anon, authenticated;
grant execute on function public.create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, uuid, boolean
) to service_role;

-- -----------------------------------------------------------------------------
-- staff_create_booking
-- -----------------------------------------------------------------------------
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
    p_customer_id
  );
end;
$$;

revoke execute on function public.staff_create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid
) from public, anon;
grant execute on function public.staff_create_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid
) to authenticated;

-- -----------------------------------------------------------------------------
-- record_manual_payment — staff mark a booking paid by cash or check.
-- SECURITY INVOKER + is_staff(), same shape as record_refund (staff already
-- have full RLS access to invoices/bookings). The QBO Payment is posted
-- afterwards by Node, best-effort; sync_status='pending' lets the daily sync
-- retry it.
-- -----------------------------------------------------------------------------
create or replace function public.record_manual_payment(
  p_booking_id uuid,
  p_method     text,            -- 'cash' | 'check'
  p_reference  text default null,
  p_note       text default null
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may record a payment'
      using errcode = '42501';
  end if;
  if p_method not in ('cash', 'check') then
    raise exception 'method must be cash or check' using errcode = '22023';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  if v_booking.payment_status = 'paid' then
    raise exception 'This booking is already marked paid'
      using errcode = '23514', hint = 'already_paid';
  end if;
  if v_booking.payment_status = 'refunded' then
    raise exception 'This booking was refunded; record a new payment in QuickBooks'
      using errcode = '23514', hint = 'refunded';
  end if;
  if v_booking.status = 'cancelled' then
    raise exception 'This booking is cancelled'
      using errcode = '23514', hint = 'cancelled';
  end if;

  insert into public.invoices
    (booking_id, amount, status, paid_at, payment_method, payment_reference,
     payment_note, recorded_by, sync_status)
  values
    (p_booking_id, v_booking.total, 'paid', now(), p_method,
     nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''), auth.uid(), 'pending')
  on conflict (booking_id) do update set
    amount            = excluded.amount,
    status            = 'paid',
    paid_at           = now(),
    payment_method    = excluded.payment_method,
    payment_reference = excluded.payment_reference,
    payment_note      = excluded.payment_note,
    recorded_by       = excluded.recorded_by,
    sync_status       = 'pending',
    updated_at        = now();

  update public.bookings
    set payment_status = 'paid'
    where id = p_booking_id
    returning * into v_booking;

  return v_booking;
end;
$$;

revoke execute on function public.record_manual_payment(uuid, text, text, text) from public, anon;
grant execute on function public.record_manual_payment(uuid, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- record_invoice_issued — Node created (and, when p_sent_to is non-null,
-- emailed) the QBO invoice. Records it as an outstanding (status 'pending')
-- invoice; sync_status 'synced' because QBO already has it, so the
-- paid-invoice sync never tries to create another. Called even when the email
-- send failed (p_sent_to null) so a created-but-unsent QBO invoice is never
-- left untracked; re-called on resend.
-- -----------------------------------------------------------------------------
create or replace function public.record_invoice_issued(
  p_booking_id    uuid,
  p_qb_invoice_id text,
  p_invoice_link  text,
  p_sent_to       text
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may record an invoice'
      using errcode = '42501';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  if v_booking.payment_status <> 'unpaid' then
    raise exception 'Only an unpaid booking can be invoiced'
      using errcode = '23514', hint = 'not_unpaid';
  end if;

  insert into public.invoices
    (booking_id, amount, status, quickbooks_invoice_id, sync_status,
     qb_invoice_link, invoice_sent_to, invoice_sent_at, qb_balance)
  values
    (p_booking_id, v_booking.total, 'pending', p_qb_invoice_id, 'synced',
     p_invoice_link, p_sent_to,
     case when p_sent_to is null then null else now() end, v_booking.total)
  on conflict (booking_id) do update set
    amount                = excluded.amount,
    status                = 'pending',
    quickbooks_invoice_id = excluded.quickbooks_invoice_id,
    sync_status           = 'synced',
    qb_invoice_link       = coalesce(excluded.qb_invoice_link, invoices.qb_invoice_link),
    invoice_sent_to       = coalesce(excluded.invoice_sent_to, invoices.invoice_sent_to),
    invoice_sent_at       = coalesce(excluded.invoice_sent_at, invoices.invoice_sent_at),
    qb_balance            = excluded.qb_balance,
    updated_at            = now();

  update public.bookings
    set quickbooks_invoice_id = p_qb_invoice_id
    where id = p_booking_id
    returning * into v_booking;

  return v_booking;
end;
$$;

revoke execute on function public.record_invoice_issued(uuid, text, text, text) from public, anon;
grant execute on function public.record_invoice_issued(uuid, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- record_invoice_payment_detected — QBO says Balance = 0. Server-derived fact
-- (the caller read it from Intuit), so service_role only. Returns true iff
-- this call is the one that flipped the booking to paid.
-- -----------------------------------------------------------------------------
create or replace function public.record_invoice_payment_detected(
  p_booking_id    uuid,
  p_qb_invoice_id text,
  p_qb_payment_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  if v_booking.payment_status <> 'unpaid' then
    return false;  -- staff recorded cash/check first, or already detected
  end if;

  update public.invoices set
    status         = 'paid',
    paid_at        = now(),
    payment_method = 'qbo_invoice',
    qb_payment_id  = p_qb_payment_id,
    recorded_by    = null,
    qb_balance     = 0,
    qb_checked_at  = now(),
    sync_status    = 'synced',
    updated_at     = now()
  where booking_id = p_booking_id
    and status = 'pending'
    and quickbooks_invoice_id = p_qb_invoice_id;
  if not found then
    return false;
  end if;

  update public.bookings set payment_status = 'paid' where id = p_booking_id;
  return true;
end;
$$;

revoke execute on function public.record_invoice_payment_detected(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_invoice_payment_detected(uuid, text, text) to service_role;
