-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 5: payment schema (QuickBooks Payments)
-- =============================================================================
-- Schema + RPCs only. No Intuit dependency — safe to apply before credentials
-- exist. The lib/quickbooks/ layer and the token manager land in a later
-- migration/commit once the sandbox app is set up.
--
--  * payment_status enum + bookings.payment_status (denormalized fast-read)
--  * invoices: QuickBooks charge/payment/refund ids + sync_status
--  * payment_attempts: queryable ledger of every failed charge + compensations
--  * quickbooks_connection: single-row OAuth token store (RLS: no policies)
--  * RPCs: record_payment, record_invoice_synced, record_payment_attempt,
--          record_refund, cancel_and_refund, quickbooks_status,
--          quickbooks_force_expire
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. payment_status
-- -----------------------------------------------------------------------------
create type public.payment_status as enum ('unpaid', 'paid', 'failed', 'refunded');

alter table public.bookings
  add column payment_status public.payment_status not null default 'unpaid';

create index bookings_payment_status_idx on public.bookings (payment_status);

-- Retire the Phase 4 dev sentinel.
update public.bookings
  set quickbooks_invoice_id = null
  where quickbooks_invoice_id = 'DEV-STUB-PAID';

-- -----------------------------------------------------------------------------
-- 2. invoices — extend with QuickBooks object ids + sync tracking
-- -----------------------------------------------------------------------------
alter table public.invoices
  add column qb_charge_id     text,
  add column qb_payment_id    text,
  add column qb_refund_id     text,
  add column refund_kind      text
    check (refund_kind is null or refund_kind in ('void', 'refund')),
  add column failure_reason   text,
  add column refunded_at      timestamptz,
  add column refunded_amount  numeric(10, 2),
  add column sync_status      text not null default 'pending'
    check (sync_status in ('pending', 'synced', 'error')),
  add column updated_at       timestamptz not null default now();

-- One invoice per booking (lets record_payment upsert cleanly).
alter table public.invoices
  add constraint invoices_booking_id_key unique (booking_id);

create index invoices_sync_status_idx on public.invoices (sync_status);

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. payment_attempts — every failed charge + every compensating action
-- -----------------------------------------------------------------------------
create table public.payment_attempts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null
    check (kind in ('declined', 'compensating_refund', 'error')),
  qb_charge_id  text,
  qb_refund_id  text,
  amount        numeric(10, 2),
  contact_email text,
  reason        text,
  context       jsonb,
  created_at    timestamptz not null default now()
);

create index payment_attempts_kind_created_idx
  on public.payment_attempts (kind, created_at desc);

alter table public.payment_attempts enable row level security;

create policy "payment_attempts: staff read"
  on public.payment_attempts for select
  using (public.is_staff());
-- Writes only via record_payment_attempt (SECURITY DEFINER).

-- -----------------------------------------------------------------------------
-- 4. quickbooks_connection — single-row OAuth token store
-- -----------------------------------------------------------------------------
-- Tokens never leave the server. This row is touched only by the token manager
-- (a direct pg connection using service credentials) and by SECURITY DEFINER
-- functions. RLS is enabled with NO policies, so PostgREST / anon / authenticated
-- cannot read it at all. Staff see status via public.quickbooks_status().
create table public.quickbooks_connection (
  id                        boolean primary key default true check (id),
  realm_id                  text,
  access_token              text,
  access_token_expires_at   timestamptz,
  refresh_token_encrypted   bytea,        -- pgp_sym_encrypt at write time
  refresh_token_expires_at  timestamptz,
  status                    text not null default 'disconnected'
    check (status in ('connected', 'disconnected', 'error')),
  refresh_count             integer not null default 0,
  last_refresh_at           timestamptz,
  last_error                text,
  connected_by              uuid references public.profiles (id) on delete set null,
  connected_at              timestamptz,
  updated_at                timestamptz not null default now()
);

insert into public.quickbooks_connection (id) values (true)
  on conflict (id) do nothing;

alter table public.quickbooks_connection enable row level security;
-- Intentionally no policies.

create trigger quickbooks_connection_set_updated_at
  before update on public.quickbooks_connection
  for each row execute function public.set_updated_at();

-- =============================================================================
-- RPCs
-- =============================================================================

-- record_payment ------------------------------------------------------------
-- Charge captured. Called from the checkout server action (service role — guest
-- checkout has no session), right after create_booking succeeds. The QBO
-- invoice id is filled in later by record_invoice_synced.
create or replace function public.record_payment(
  p_booking_id    uuid,
  p_qb_charge_id  text,
  p_qb_payment_id text,
  p_amount        numeric
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.bookings;
begin
  insert into public.invoices
    (booking_id, amount, status, paid_at, qb_charge_id, qb_payment_id, sync_status)
  values
    (p_booking_id, p_amount, 'paid', now(), p_qb_charge_id, p_qb_payment_id, 'pending')
  on conflict (booking_id) do update set
    amount        = excluded.amount,
    status        = 'paid',
    paid_at       = now(),
    qb_charge_id  = excluded.qb_charge_id,
    qb_payment_id = excluded.qb_payment_id,
    sync_status   = 'pending',
    updated_at    = now();

  update public.bookings
    set payment_status = 'paid'
    where id = p_booking_id
    returning * into v_row;

  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- record_invoice_synced ---------------------------------------------------
-- The QBO invoice was created (checkout step f, or the reconcile cron).
create or replace function public.record_invoice_synced(
  p_booking_id    uuid,
  p_qb_invoice_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.invoices set
    quickbooks_invoice_id = p_qb_invoice_id,
    sync_status           = 'synced',
    updated_at            = now()
  where booking_id = p_booking_id;

  if not found then
    raise exception 'No invoice for booking %', p_booking_id using errcode = 'P0002';
  end if;

  update public.bookings
    set quickbooks_invoice_id = p_qb_invoice_id
    where id = p_booking_id;
end;
$$;

-- record_payment_attempt -------------------------------------------------
-- Every failed charge at checkout (kind 'declined'), the post-race auto-refund
-- (kind 'compensating_refund'), and charge-path errors (kind 'error').
-- No booking_id — these are events with no surviving booking.
create or replace function public.record_payment_attempt(
  p_kind          text,
  p_qb_charge_id  text,
  p_qb_refund_id  text,
  p_amount        numeric,
  p_contact_email text,
  p_reason        text,
  p_context       jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.payment_attempts
    (kind, qb_charge_id, qb_refund_id, amount, contact_email, reason, context)
  values
    (p_kind, p_qb_charge_id, p_qb_refund_id, p_amount, p_contact_email, p_reason, p_context)
  returning id into v_id;
  return v_id;
end;
$$;

-- record_refund ---------------------------------------------------------
-- Admin-initiated refund, independent of booking lifecycle. The QuickBooks
-- refund call happens in Node first; its id is passed in here.
create or replace function public.record_refund(
  p_booking_id   uuid,
  p_qb_refund_id text,
  p_refund_kind  text,           -- 'void' | 'refund'
  p_amount       numeric
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
    raise exception 'Only staff or owner may record a refund'
      using errcode = '42501';
  end if;
  if p_refund_kind not in ('void', 'refund') then
    raise exception 'refund_kind must be void or refund' using errcode = '22023';
  end if;

  update public.invoices set
    status          = 'refunded',
    qb_refund_id    = p_qb_refund_id,
    refund_kind     = p_refund_kind,
    refunded_at     = now(),
    refunded_amount = p_amount,
    updated_at      = now()
  where booking_id = p_booking_id;

  if not found then
    raise exception 'No invoice for booking %', p_booking_id using errcode = 'P0002';
  end if;

  update public.bookings
    set payment_status = 'refunded'
    where id = p_booking_id
    returning * into v_row;

  return v_row;
end;
$$;

-- cancel_and_refund ---------------------------------------------------
-- Combined shortcut: refund bookkeeping + cancel, one transaction. Both inner
-- calls re-check is_staff() against the real caller (auth.uid() is unaffected
-- by any SECURITY setting). If set_booking_status raises (e.g. the booking is
-- already terminal), the refund writes roll back too.
create or replace function public.cancel_and_refund(
  p_booking_id   uuid,
  p_qb_refund_id text,
  p_refund_kind  text,
  p_amount       numeric
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
    raise exception 'Only staff or owner may cancel and refund'
      using errcode = '42501';
  end if;

  perform public.record_refund(p_booking_id, p_qb_refund_id, p_refund_kind, p_amount);
  perform public.set_booking_status(p_booking_id, 'cancelled');

  select * into v_row from public.bookings where id = p_booking_id;
  return v_row;
end;
$$;

-- quickbooks_status -------------------------------------------------
-- Staff-visible connection status. Never returns tokens.
create or replace function public.quickbooks_status()
returns table (
  status                  text,
  realm_id                text,
  connected_at            timestamptz,
  last_refresh_at         timestamptz,
  refresh_count           integer,
  last_error              text,
  access_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;
  return query
    select c.status, c.realm_id, c.connected_at, c.last_refresh_at,
           c.refresh_count, c.last_error, c.access_token_expires_at
    from public.quickbooks_connection c
    where c.id = true;
end;
$$;

-- quickbooks_force_expire ------------------------------------------
-- DEV ONLY. The caller (an API route) must gate this on CL_ENABLE_DEV_STUBS.
-- Forces the stored access token stale so the next API call exercises the
-- refresh path during same-day testing.
create or replace function public.quickbooks_force_expire()
returns void
language sql
security definer
set search_path = public
as $$
  update public.quickbooks_connection
  set access_token_expires_at = now() - interval '1 minute',
      updated_at = now()
  where id = true;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
grant execute on function public.record_payment(uuid, text, text, numeric) to service_role;
grant execute on function public.record_invoice_synced(uuid, text) to service_role;
grant execute on function public.record_payment_attempt(text, text, text, numeric, text, text, jsonb) to service_role;
grant execute on function public.record_refund(uuid, text, text, numeric) to authenticated;
grant execute on function public.cancel_and_refund(uuid, text, text, numeric) to authenticated;
grant execute on function public.quickbooks_status() to authenticated;
grant execute on function public.quickbooks_force_expire() to service_role;
