-- =============================================================================
-- Crazy Larry's Dumpsters — customer pay links for staff phone bookings
-- =============================================================================
-- Staff book on /bookings/new; the booking is created unpaid and holds a
-- unit; the customer is sent a link to /pay/<token> where they acknowledge
-- the agreement and pay by card. Everything here is ADDITIVE: new enum
-- values, new tables, new functions, two nullable columns, one trigger.
-- No existing function is replaced.
--
--  1. notification_type: pay_link, pay_link_reminder, staff_unpaid_alert
--  2. cl_pay_link_settings  — singleton; feature OFF by default; owner writes
--  3. pay_links             — one row per issued link; only a SHA-256 of the
--                             token is stored; one active link per booking
--  4. pay_link_events       — reminder / staff-alert ledger; the unique key is
--                             what makes a cron re-run unable to resend
--  5. consent_records       — who recorded SMS consent, when, how, for what
--  6. pay_link_lookup_attempts — per-client counters for the token lookup
--  7. invoices.pay_link_id, payment_attempts.resolved_at/_by (needs-action)
--  8. trigger bookings_end_pay_links — any other path that pays, refunds or
--     cancels a booking ends its active link (and so its reminders)
--  9. RPCs (grants at the bottom of each):
--       staff session (authenticated + is_staff()):
--         staff_create_pay_link_booking, issue_pay_link,
--         resolve_payment_attempt
--       service_role only (the public /pay page and the daily cron):
--         pay_link_lookup, pay_link_begin_charge, pay_link_clear_charge,
--         record_pay_link_payment, pay_link_due_events, claim_pay_link_event,
--         finish_pay_link_event, pay_link_staff_alert_recipients,
--         purge_pay_link_lookup_attempts
--
-- Private by default (20260924000000/010000): every grant below is explicit.
-- Yard day: dates are America/New_York via public.yard_today().
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. notification types (not used anywhere in this migration, so ADD VALUE
--    inside the migration's transaction is fine)
-- -----------------------------------------------------------------------------
alter type public.notification_type add value if not exists 'pay_link';
alter type public.notification_type add value if not exists 'pay_link_reminder';
alter type public.notification_type add value if not exists 'staff_unpaid_alert';

-- -----------------------------------------------------------------------------
-- 2. cl_pay_link_settings
-- -----------------------------------------------------------------------------
create table public.cl_pay_link_settings (
  id                        boolean primary key default true check (id),
  enabled                   boolean not null default false,
  reminder_after_days       integer not null default 2
    check (reminder_after_days between 1 and 30),
  reminder_repeat           boolean not null default false,
  reminder_max              integer not null default 3
    check (reminder_max between 1 and 10),
  staff_alert_after_days    integer not null default 3
    check (staff_alert_after_days between 1 and 30),
  staff_alert_user_id       uuid references public.profiles (id) on delete set null,
  staff_alert_each_reminder boolean not null default false,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references public.profiles (id) on delete set null
);

insert into public.cl_pay_link_settings (id) values (true)
  on conflict (id) do nothing;

create trigger cl_pay_link_settings_set_updated_at
  before update on public.cl_pay_link_settings
  for each row execute function public.set_updated_at();

-- The chosen alert recipient must be an active, visible staff or owner at the
-- time it is chosen. If they are removed later, the cron falls back to all
-- owners and Settings warns (pay_link_staff_alert_recipients).
create or replace function public.validate_pay_link_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.staff_alert_user_id is not null
     and new.staff_alert_user_id is distinct from old.staff_alert_user_id
     and not exists (
       select 1 from public.profiles p
       where p.id = new.staff_alert_user_id
         and p.role in ('staff', 'owner')
         and p.removed_at is null
         and not p.hidden_from_users
     ) then
    raise exception 'Pick an active staff or owner account for unpaid-booking alerts'
      using errcode = '23514', hint = 'bad_alert_user';
  end if;
  return new;
end;
$$;

revoke execute on function public.validate_pay_link_settings() from public, anon, authenticated;

create trigger cl_pay_link_settings_validate
  before update on public.cl_pay_link_settings
  for each row execute function public.validate_pay_link_settings();

alter table public.cl_pay_link_settings enable row level security;

create policy "cl_pay_link_settings: staff read"
  on public.cl_pay_link_settings for select
  using (public.is_staff());

create policy "cl_pay_link_settings: owner update"
  on public.cl_pay_link_settings for update
  using (public.is_owner()) with check (public.is_owner());

grant select, update on public.cl_pay_link_settings to authenticated;

-- -----------------------------------------------------------------------------
-- 3. pay_links
-- -----------------------------------------------------------------------------
create table public.pay_links (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references public.bookings (id) on delete restrict,
  token_hash        bytea not null unique,           -- sha256 of the token text
  status            text not null default 'active'
    check (status in ('active', 'paid', 'superseded', 'ended')),
  ended_reason      text
    check (ended_reason is null or ended_reason in
      ('booking_cancelled', 'paid_other_path', 'payment_status_changed')),
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  ended_at          timestamptz,
  -- The customer ticked the agreement on THIS link before the charge.
  agreement_ack_at  timestamptz,
  -- One charge attempt at a time: the Intuit Request-Id and when it began.
  charge_request_id uuid,
  charge_started_at timestamptz,
  qb_charge_id      text,
  paid_at           timestamptz,
  constraint pay_links_ended_iff_not_active
    check ((status = 'active') = (ended_at is null)),
  constraint pay_links_paid_has_charge
    check (status <> 'paid' or (qb_charge_id is not null and paid_at is not null))
);

create unique index pay_links_one_active_per_booking
  on public.pay_links (booking_id) where status = 'active';
create index pay_links_booking_id_idx on public.pay_links (booking_id);

alter table public.pay_links enable row level security;

create policy "pay_links: staff read"
  on public.pay_links for select
  using (public.is_staff());
-- Writes only through the functions below.

grant select on public.pay_links to authenticated;

-- -----------------------------------------------------------------------------
-- 4. pay_link_events — reminder / alert ledger
-- -----------------------------------------------------------------------------
-- The cron claims (booking, kind, seq) BEFORE sending. A re-run finds the row
-- and sends nothing. A crash between claim and send loses that one message
-- (status stays 'claimed') rather than risking a duplicate.
create table public.pay_link_events (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references public.bookings (id) on delete restrict,
  pay_link_id  uuid references public.pay_links (id) on delete set null,
  kind         text not null
    check (kind in ('customer_reminder', 'staff_alert', 'staff_alert_on_reminder')),
  seq          integer not null check (seq >= 1),
  yard_date    date not null,
  status       text not null default 'claimed'
    check (status in ('claimed', 'sent', 'failed')),
  detail       text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  constraint pay_link_events_once unique (booking_id, kind, seq)
);

alter table public.pay_link_events enable row level security;

create policy "pay_link_events: staff read"
  on public.pay_link_events for select
  using (public.is_staff());

grant select on public.pay_link_events to authenticated;

-- -----------------------------------------------------------------------------
-- 5. consent_records
-- -----------------------------------------------------------------------------
-- customers.sms_consent stays the fast flag the send path reads; this is the
-- evidence behind it. STOP/START ingestion is a later migration (it will add
-- its sources to the check); START never re-grants consent automatically.
create table public.consent_records (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers (id) on delete restrict,
  booking_id   uuid references public.bookings (id) on delete set null,
  pay_link_id  uuid references public.pay_links (id) on delete set null,
  channel      text not null default 'sms' check (channel in ('sms')),
  granted      boolean not null,
  source       text not null check (source in ('phone_verbal', 'pay_page')),
  recorded_by  uuid references public.profiles (id) on delete set null,
  recorded_at  timestamptz not null default now()
);

create index consent_records_customer_idx on public.consent_records (customer_id, recorded_at desc);

alter table public.consent_records enable row level security;

create policy "consent_records: staff read"
  on public.consent_records for select
  using (public.is_staff());

grant select on public.consent_records to authenticated;

-- -----------------------------------------------------------------------------
-- 6. pay_link_lookup_attempts — rate limit for the public token lookup
-- -----------------------------------------------------------------------------
-- client_key is an HMAC of the client IP computed in Node with a server
-- secret; raw IPs are never stored. 10-minute windows. No policies and no
-- API-role grants: only service_role (through the lookup) touches it.
create table public.pay_link_lookup_attempts (
  client_key   text not null,
  window_start timestamptz not null,
  lookups      integer not null default 0,
  failures     integer not null default 0,
  primary key (client_key, window_start)
);

alter table public.pay_link_lookup_attempts enable row level security;

-- -----------------------------------------------------------------------------
-- 7. columns on existing tables (nullable, no defaults to backfill)
-- -----------------------------------------------------------------------------
alter table public.invoices
  add column pay_link_id uuid references public.pay_links (id) on delete set null;

-- Needs-action: a compensating refund that failed stays on the dashboard
-- until a staff member marks it handled.
alter table public.payment_attempts
  add column resolved_at timestamptz,
  add column resolved_by uuid references public.profiles (id) on delete set null;

create index payment_attempts_unresolved_refund_failed_idx
  on public.payment_attempts (created_at desc)
  where kind = 'compensating_refund' and resolved_at is null;

-- -----------------------------------------------------------------------------
-- 8. bookings -> pay_links: any other path ends the active link
-- -----------------------------------------------------------------------------
-- Fires only when payment_status leaves 'unpaid' or status becomes
-- 'cancelled'. record_pay_link_payment marks its link 'paid' BEFORE flipping
-- the booking, so this finds nothing active on that path.
create or replace function public.end_pay_links_on_booking_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    v_reason := 'booking_cancelled';
  elsif new.payment_status = 'paid' then
    v_reason := 'paid_other_path';
  else
    v_reason := 'payment_status_changed';
  end if;

  update public.pay_links
     set status = 'ended', ended_at = now(), ended_reason = v_reason
   where booking_id = new.id and status = 'active';
  return null;
end;
$$;

revoke execute on function public.end_pay_links_on_booking_change() from public, anon, authenticated;

create trigger bookings_end_pay_links
  after update of payment_status, status on public.bookings
  for each row
  when (
    (old.payment_status = 'unpaid' and new.payment_status <> 'unpaid')
    or (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  )
  execute function public.end_pay_links_on_booking_change();

-- -----------------------------------------------------------------------------
-- 9. functions
-- -----------------------------------------------------------------------------

-- Token: 32 random bytes, base64url without padding (43 chars). Only its
-- SHA-256 is stored; the text is returned once and never kept.
create or replace function public._pay_link_hash(p_token text)
returns bytea
language sql
immutable
set search_path = public
as $$
  select extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256');
$$;

revoke execute on function public._pay_link_hash(text) from public, anon, authenticated;

-- Internal: supersede the active link (if any) and issue a new one. Callers
-- hold the booking row lock and have already checked the booking.
create or replace function public._issue_pay_link(p_booking_id uuid, p_actor uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  update public.pay_links
     set status = 'superseded', ended_at = now()
   where booking_id = p_booking_id and status = 'active';

  v_token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  insert into public.pay_links (booking_id, token_hash, created_by)
  values (p_booking_id, public._pay_link_hash(v_token), p_actor);
  return v_token;
end;
$$;

revoke execute on function public._issue_pay_link(uuid, uuid) from public, anon, authenticated;

-- Internal: the checks every issue path shares. Locks the booking.
create or replace function public._assert_pay_link_issuable(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if not coalesce((select enabled from public.cl_pay_link_settings where id), false) then
    raise exception 'Pay links are turned off in Settings'
      using errcode = '23514', hint = 'pay_links_disabled';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'Booking % not found', p_booking_id using errcode = 'P0002';
  end if;
  if v_booking.status in ('cancelled', 'returned') then
    raise exception 'This booking is %', v_booking.status
      using errcode = '23514', hint = 'not_open';
  end if;
  if v_booking.payment_status <> 'unpaid' then
    raise exception 'Only an unpaid booking can get a pay link'
      using errcode = '23514', hint = 'not_unpaid';
  end if;
  if exists (
    select 1 from public.invoices i
    where i.booking_id = p_booking_id
      and i.status = 'pending'
      and i.quickbooks_invoice_id is not null
  ) then
    raise exception 'A QuickBooks invoice is still open for this booking — void it in QuickBooks first'
      using errcode = '23514', hint = 'qbo_invoice_pending';
  end if;
  return v_booking;
end;
$$;

revoke execute on function public._assert_pay_link_issuable(uuid) from public, anon, authenticated;

-- issue_pay_link — staff "Send / Resend pay link". The old link stops working
-- in the same transaction the new one is created.
create or replace function public.issue_pay_link(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may send pay links' using errcode = '42501';
  end if;
  perform public._assert_pay_link_issuable(p_booking_id);
  return public._issue_pay_link(p_booking_id, auth.uid());
end;
$$;

revoke execute on function public.issue_pay_link(uuid) from public, anon;
grant execute on function public.issue_pay_link(uuid) to authenticated;

-- staff_create_pay_link_booking — Book on /bookings/new with the feature on.
-- One transaction: the booking (same _create_booking_core as every other
-- path), the verbal-consent record, and the link. Contact rule: an email, or
-- a phone number with recorded verbal consent to texts.
create or replace function public.staff_create_pay_link_booking(
  p_size              public.dumpster_size,
  p_delivery_date     date,
  p_delivery_address  text,
  p_contact_name      text,
  p_rental_days       integer default 5,
  p_placement_notes   text default null,
  p_debris_type       text default null,
  p_contact_email     text default null,
  p_contact_phone     text default null,
  p_company_name      text default null,
  p_verbal_sms_consent boolean default false,
  p_customer_id       uuid default null
)
returns table (booking_id uuid, token text)
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
  token := public._issue_pay_link(v_booking_id, auth.uid());
  return next;
end;
$$;

revoke execute on function public.staff_create_pay_link_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid
) from public, anon;
grant execute on function public.staff_create_pay_link_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid
) to authenticated;

-- pay_link_lookup — the public page's only read. Counts the attempt against
-- the client first; refuses over 30 lookups or 10 misses per 10 minutes.
-- Returns one of:
--   {state:'throttled'} | {state:'not_found'} | {state:'paid'}
--   {state:'active', link_id, booking_id, first_name, size, delivery_date,
--    pickup_date, delivery_address, subtotal, tax, total}
-- 'not_found' covers unknown, superseded and ended links alike, so the page
-- can't be used to learn which.
create or replace function public.pay_link_lookup(p_token text, p_client_key text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_window timestamptz := date_bin('10 minutes', now(), timestamptz '2000-01-01');
  v_counts public.pay_link_lookup_attempts;
  v_link   public.pay_links;
  v_b      record;
begin
  insert into public.pay_link_lookup_attempts (client_key, window_start, lookups)
  values (coalesce(p_client_key, 'unknown'), v_window, 1)
  on conflict (client_key, window_start)
    do update set lookups = pay_link_lookup_attempts.lookups + 1
  returning * into v_counts;

  if v_counts.lookups > 30 or v_counts.failures >= 10 then
    return jsonb_build_object('state', 'throttled');
  end if;

  select * into v_link from public.pay_links
   where token_hash = public._pay_link_hash(p_token);

  if not found or v_link.status not in ('active', 'paid') then
    update public.pay_link_lookup_attempts set failures = failures + 1
     where client_key = v_counts.client_key and window_start = v_window;
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_link.status = 'paid' then
    return jsonb_build_object('state', 'paid');
  end if;

  select b.id, b.size_requested, b.delivery_date, b.pickup_date, b.delivery_address,
         b.subtotal, b.tax, b.total, b.status, b.payment_status,
         split_part(btrim(c.full_name), ' ', 1) as first_name
    into v_b
    from public.bookings b
    join public.customers c on c.id = b.customer_id
   where b.id = v_link.booking_id;

  -- The trigger ends links on cancel/paid; this is belt and braces.
  if v_b.status = 'cancelled' or v_b.payment_status <> 'unpaid' then
    return jsonb_build_object('state', 'not_found');
  end if;

  return jsonb_build_object(
    'state', 'active',
    'link_id', v_link.id,
    'booking_id', v_b.id,
    'first_name', v_b.first_name,
    'size', v_b.size_requested,
    'delivery_date', v_b.delivery_date,
    'pickup_date', v_b.pickup_date,
    'delivery_address', v_b.delivery_address,
    'subtotal', v_b.subtotal,
    'tax', v_b.tax,
    'total', v_b.total
  );
end;
$$;

revoke execute on function public.pay_link_lookup(text, text) from public, anon, authenticated;
grant execute on function public.pay_link_lookup(text, text) to service_role;

-- pay_link_begin_charge — under the booking + link locks: the link is live,
-- the booking is unpaid and open, the page's total is still the saved total,
-- the agreement was ticked, and no other charge on this link started in the
-- last 2 minutes (double click / second tab). Records the agreement time on
-- this link and hands out a fresh Intuit Request-Id.
-- Returns {state:'ok', link_id, booking_id, request_id, amount}
--   | {state:'not_found'} | {state:'paid'} | {state:'in_progress'}
--   | {state:'amount_changed', total} | {state:'no_agreement'}
create or replace function public.pay_link_begin_charge(
  p_token          text,
  p_expected_total numeric,
  p_agreement      boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link_id    uuid;
  v_booking_id uuid;
  v_link       public.pay_links;
  v_booking    public.bookings;
  v_request    uuid;
begin
  select id, booking_id into v_link_id, v_booking_id
    from public.pay_links where token_hash = public._pay_link_hash(p_token);
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  -- Lock order everywhere: booking, then link.
  select * into v_booking from public.bookings where id = v_booking_id for update;
  select * into v_link from public.pay_links where id = v_link_id for update;

  if v_link.status = 'paid' then
    return jsonb_build_object('state', 'paid');
  end if;
  if v_link.status <> 'active' or v_booking.status = 'cancelled'
     or v_booking.payment_status <> 'unpaid' then
    return jsonb_build_object('state', 'not_found');
  end if;
  if not coalesce(p_agreement, false) then
    return jsonb_build_object('state', 'no_agreement');
  end if;
  if p_expected_total is null or round(p_expected_total, 2) <> v_booking.total then
    return jsonb_build_object('state', 'amount_changed', 'total', v_booking.total);
  end if;
  if v_link.charge_started_at is not null
     and v_link.charge_started_at > now() - interval '2 minutes' then
    return jsonb_build_object('state', 'in_progress');
  end if;

  v_request := gen_random_uuid();
  update public.pay_links
     set charge_request_id = v_request,
         charge_started_at = now(),
         agreement_ack_at  = now()
   where id = v_link_id;

  return jsonb_build_object(
    'state', 'ok',
    'link_id', v_link_id,
    'booking_id', v_booking_id,
    'request_id', v_request,
    'amount', v_booking.total
  );
end;
$$;

revoke execute on function public.pay_link_begin_charge(text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.pay_link_begin_charge(text, numeric, boolean) to service_role;

-- pay_link_clear_charge — the card was declined (nothing captured), so the
-- customer may retry at once instead of waiting out the 2 minutes.
create or replace function public.pay_link_clear_charge(p_link_id uuid, p_request_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.pay_links
     set charge_started_at = null
   where id = p_link_id and charge_request_id = p_request_id and status = 'active';
$$;

revoke execute on function public.pay_link_clear_charge(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pay_link_clear_charge(uuid, uuid) to service_role;

-- record_pay_link_payment — the charge was captured. Under the booking +
-- link locks it either records the payment (invoice row, link 'paid',
-- booking 'paid', optional SMS opt-in with its own timestamp) or refuses, and
-- the caller refunds. Idempotent for the same charge id.
-- Returns: 'recorded' | 'already_recorded' | 'refused_cancelled'
--        | 'refused_paid' | 'refused_link' | 'refused_amount'
create or replace function public.record_pay_link_payment(
  p_link_id      uuid,
  p_request_id   uuid,
  p_qb_charge_id text,
  p_amount       numeric,
  p_sms_opt_in   boolean default false
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_link       public.pay_links;
  v_booking    public.bookings;
begin
  select booking_id into v_booking_id from public.pay_links where id = p_link_id;
  if not found then
    return 'refused_link';
  end if;
  select * into v_booking from public.bookings where id = v_booking_id for update;
  select * into v_link from public.pay_links where id = p_link_id for update;

  if v_link.status = 'paid' and v_link.qb_charge_id = p_qb_charge_id then
    return 'already_recorded';
  end if;
  if v_booking.status = 'cancelled' then
    return 'refused_cancelled';
  end if;
  if v_booking.payment_status <> 'unpaid' then
    return 'refused_paid';
  end if;
  if v_link.status <> 'active' or v_link.charge_request_id is distinct from p_request_id then
    return 'refused_link';
  end if;
  if p_amount is null or round(p_amount, 2) <> v_booking.total then
    return 'refused_amount';
  end if;

  insert into public.invoices
    (booking_id, amount, status, paid_at, qb_charge_id, payment_method,
     pay_link_id, recorded_by, sync_status)
  values
    (v_booking_id, v_booking.total, 'paid', now(), p_qb_charge_id, 'card',
     p_link_id, null, 'pending')
  on conflict (booking_id) do update set
    amount         = excluded.amount,
    status         = 'paid',
    paid_at        = now(),
    qb_charge_id   = excluded.qb_charge_id,
    payment_method = 'card',
    pay_link_id    = excluded.pay_link_id,
    recorded_by    = null,
    sync_status    = 'pending',
    updated_at     = now();

  -- Link first, so the bookings trigger finds nothing active to end.
  update public.pay_links
     set status = 'paid', paid_at = now(), ended_at = now(),
         qb_charge_id = p_qb_charge_id, charge_started_at = null
   where id = p_link_id;

  update public.bookings set payment_status = 'paid' where id = v_booking_id;

  if coalesce(p_sms_opt_in, false) then
    update public.customers set sms_consent = true where id = v_booking.customer_id;
    insert into public.consent_records
      (customer_id, booking_id, pay_link_id, granted, source, recorded_by)
    values (v_booking.customer_id, v_booking_id, p_link_id, true, 'pay_page', null);
  end if;

  return 'recorded';
end;
$$;

revoke execute on function public.record_pay_link_payment(uuid, uuid, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.record_pay_link_payment(uuid, uuid, text, numeric, boolean) to service_role;

-- pay_link_due_events — what the daily cron should send today (yard day).
-- For each booking with an ACTIVE link (so unpaid, not cancelled), with C =
-- the yard day the booking was made:
--   customer_reminder: k-th due on C + N*k; one only unless repeat, then up
--     to reminder_max. Only the highest due k is returned (missed days are
--     skipped, never sent in a burst). None after the delivery date.
--   staff_alert: once, from C + M on.
-- Nothing at all while the feature is off. Already-claimed rows are excluded;
-- claim_pay_link_event is still the guard. DEFINER because yard_today() is
-- executable by its owner only (20261029000000).
create or replace function public.pay_link_due_events(p_today date default null)
returns table (booking_id uuid, pay_link_id uuid, kind text, seq integer)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select * from public.cl_pay_link_settings where id and enabled
  ),
  t as (
    select coalesce(p_today, public.yard_today()) as today
  ),
  open_links as (
    select l.id as pay_link_id, b.id as booking_id, b.delivery_date,
           (b.created_at at time zone 'America/New_York')::date as made
      from public.pay_links l
      join public.bookings b on b.id = l.booking_id
     where l.status = 'active'
       and b.payment_status = 'unpaid'
       and b.status <> 'cancelled'
  ),
  reminders as (
    select o.booking_id, o.pay_link_id, 'customer_reminder'::text as kind,
           least(
             (t.today - o.made) / s.reminder_after_days,
             case when s.reminder_repeat then s.reminder_max else 1 end
           ) as seq
      from open_links o, s, t
     where t.today <= o.delivery_date
  ),
  alerts as (
    select o.booking_id, o.pay_link_id, 'staff_alert'::text as kind, 1 as seq
      from open_links o, s, t
     where t.today >= o.made + s.staff_alert_after_days
  )
  select r.booking_id, r.pay_link_id, r.kind, r.seq
    from reminders r
   where r.seq >= 1
     and r.seq > coalesce((select max(e.seq) from public.pay_link_events e
                            where e.booking_id = r.booking_id and e.kind = r.kind), 0)
  union all
  select a.booking_id, a.pay_link_id, a.kind, a.seq
    from alerts a
   where not exists (select 1 from public.pay_link_events e
                      where e.booking_id = a.booking_id and e.kind = 'staff_alert');
$$;

revoke execute on function public.pay_link_due_events(date) from public, anon, authenticated;
grant execute on function public.pay_link_due_events(date) to service_role;

-- claim_pay_link_event — insert-before-send. true = this caller owns the send;
-- false = already claimed (a re-run), or the link/booking is no longer open.
create or replace function public.claim_pay_link_event(
  p_booking_id uuid,
  p_kind       text,
  p_seq        integer,
  p_yard_date  date
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_link_id uuid;
  v_id      uuid;
begin
  select l.id into v_link_id
    from public.pay_links l
    join public.bookings b on b.id = l.booking_id
   where l.booking_id = p_booking_id and l.status = 'active'
     and b.payment_status = 'unpaid' and b.status <> 'cancelled';
  if v_link_id is null then
    return false;
  end if;

  insert into public.pay_link_events (booking_id, pay_link_id, kind, seq, yard_date)
  values (p_booking_id, v_link_id, p_kind, p_seq, p_yard_date)
  on conflict on constraint pay_link_events_once do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke execute on function public.claim_pay_link_event(uuid, text, integer, date) from public, anon, authenticated;
grant execute on function public.claim_pay_link_event(uuid, text, integer, date) to service_role;

-- finish_pay_link_event — the cron records how the claimed send went.
create or replace function public.finish_pay_link_event(
  p_booking_id uuid,
  p_kind       text,
  p_seq        integer,
  p_status     text,
  p_detail     text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'status must be sent or failed' using errcode = '22023';
  end if;
  update public.pay_link_events
     set status = p_status, detail = left(p_detail, 300), completed_at = now()
   where booking_id = p_booking_id and kind = p_kind and seq = p_seq and status = 'claimed';
end;
$$;

revoke execute on function public.finish_pay_link_event(uuid, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.finish_pay_link_event(uuid, text, integer, text, text) to service_role;

-- pay_link_staff_alert_recipients — who gets the unpaid-booking alert email.
-- The chosen user while they're an active, visible, unbanned staff/owner with
-- an email; otherwise every such OWNER (hidden accounts like the seed owner
-- never count), with via_fallback = true so Settings can warn.
create or replace function public.pay_link_staff_alert_recipients()
returns table (profile_id uuid, email text, full_name text, via_fallback boolean)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select p.id, u.email::text as email, p.full_name, p.role
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.role in ('staff', 'owner')
       and p.removed_at is null
       and not p.hidden_from_users
       and (u.banned_until is null or u.banned_until < now())
       and u.email is not null
  ),
  chosen as (
    select e.* from eligible e
     where e.id = (select staff_alert_user_id from public.cl_pay_link_settings where id)
  )
  select c.id, c.email, c.full_name, false from chosen c
  union all
  select e.id, e.email, e.full_name, true from eligible e
   where e.role = 'owner' and not exists (select 1 from chosen)
   order by 3;
$$;

revoke execute on function public.pay_link_staff_alert_recipients() from public, anon, authenticated;
grant execute on function public.pay_link_staff_alert_recipients() to service_role;

-- resolve_payment_attempt — staff clear a needs-action entry (a failed
-- compensating refund) once they've handled it in QuickBooks.
create or replace function public.resolve_payment_attempt(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may resolve payment problems' using errcode = '42501';
  end if;
  update public.payment_attempts
     set resolved_at = now(), resolved_by = auth.uid()
   where id = p_attempt_id and resolved_at is null;
  if not found then
    raise exception 'Nothing to resolve' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.resolve_payment_attempt(uuid) from public, anon;
grant execute on function public.resolve_payment_attempt(uuid) to authenticated;

-- purge_pay_link_lookup_attempts — daily cron housekeeping.
create or replace function public.purge_pay_link_lookup_attempts()
returns integer
language sql
security invoker
set search_path = public
as $$
  with d as (
    delete from public.pay_link_lookup_attempts
     where window_start < now() - interval '1 day'
    returning 1
  )
  select count(*)::int from d;
$$;

revoke execute on function public.purge_pay_link_lookup_attempts() from public, anon, authenticated;
grant execute on function public.purge_pay_link_lookup_attempts() to service_role;
