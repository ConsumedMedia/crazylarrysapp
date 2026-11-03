-- =============================================================================
-- Crazy Larry's Dumpsters — pay links: keep the live link, encrypted, for reminders
-- =============================================================================
-- 20261103000000 stores only a SHA-256 of each pay-link token, so the daily
-- cron can't put the link in a customer reminder. This adds the token,
-- encrypted, for ACTIVE links only:
--
--  1. pay_links.token_encrypted bytea (nullable). pgp_sym_encrypt (AES-256)
--     with a key the SERVER passes in (env CL_PAY_LINK_TOKEN_KEY); the key is
--     never stored in the database. Same pattern as the QuickBooks refresh
--     token (pgp_sym_encrypt with QUICKBOOKS_TOKEN_ENC_KEY).
--  2. Readable by service_role only: authenticated loses table-wide SELECT on
--     pay_links and gets every OTHER column back by name. anon had nothing.
--  3. Cleared the moment a link stops being active (paid, superseded, ended),
--     by a BEFORE trigger, so no other function needs to know about it; a
--     check constraint makes "encrypted value on a dead link" impossible.
--  4. _issue_pay_link / issue_pay_link / staff_create_pay_link_booking are
--     rebuilt from their LIVE definitions (read 2026-11-03) with one new
--     trailing argument, p_token_key text DEFAULT NULL. A null or empty key
--     issues the link exactly as before, just without a stored copy. The old
--     signatures are dropped; no deployed code calls them (only the
--     uncommitted staff library, which keeps working through the default).
--  5. pay_link_reminder_token(booking, key) — service_role: the active link's
--     token, decrypted and checked against token_hash, or why not.
--  6. pay_link_live_counts() — staff: live links and how many of them have
--     no stored copy (for the Settings page).
--
-- Links with no encrypted value (issued before this migration or while the
-- key was unset) still work for paying; they just can't be put in a reminder
-- until staff press Resend, which issues a new link with a stored copy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1-3. the column, who can read it, and when it is cleared
-- -----------------------------------------------------------------------------
alter table public.pay_links
  add column token_encrypted bytea;

comment on column public.pay_links.token_encrypted is
  'pgp_sym_encrypt(token, CL_PAY_LINK_TOKEN_KEY). Active links only; service_role only.';

create or replace function public.clear_pay_link_token()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'active' then
    new.token_encrypted := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.clear_pay_link_token() from public, anon, authenticated;

create trigger pay_links_clear_token
  before insert or update on public.pay_links
  for each row execute function public.clear_pay_link_token();

alter table public.pay_links
  add constraint pay_links_token_only_while_active
    check (token_encrypted is null or status = 'active');

revoke select on public.pay_links from authenticated;
grant select (
  id, booking_id, token_hash, status, ended_reason, created_by, created_at,
  ended_at, agreement_ack_at, charge_request_id, charge_started_at,
  qb_charge_id, paid_at
) on public.pay_links to authenticated;

-- -----------------------------------------------------------------------------
-- 4. issuing, rebuilt from the live definitions + p_token_key
-- -----------------------------------------------------------------------------
drop function public.issue_pay_link(uuid);
drop function public.staff_create_pay_link_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid
);
drop function public._issue_pay_link(uuid, uuid);

create or replace function public._issue_pay_link(
  p_booking_id uuid,
  p_actor      uuid,
  p_token_key  text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_key   text := nullif(p_token_key, '');
begin
  update public.pay_links
     set status = 'superseded', ended_at = now()
   where booking_id = p_booking_id and status = 'active';

  v_token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  insert into public.pay_links (booking_id, token_hash, created_by, token_encrypted)
  values (
    p_booking_id,
    public._pay_link_hash(v_token),
    p_actor,
    case when v_key is null then null
         else extensions.pgp_sym_encrypt(v_token, v_key, 'cipher-algo=aes256') end
  );
  return v_token;
end;
$$;

revoke execute on function public._issue_pay_link(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.issue_pay_link(
  p_booking_id uuid,
  p_token_key  text default null
)
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
  return public._issue_pay_link(p_booking_id, auth.uid(), p_token_key);
end;
$$;

revoke execute on function public.issue_pay_link(uuid, text) from public, anon;
grant execute on function public.issue_pay_link(uuid, text) to authenticated;

create or replace function public.staff_create_pay_link_booking(
  p_size               public.dumpster_size,
  p_delivery_date      date,
  p_delivery_address   text,
  p_contact_name       text,
  p_rental_days        integer default 5,
  p_placement_notes    text default null,
  p_debris_type        text default null,
  p_contact_email      text default null,
  p_contact_phone      text default null,
  p_company_name       text default null,
  p_verbal_sms_consent boolean default false,
  p_customer_id        uuid default null,
  p_token_key          text default null
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
  token := public._issue_pay_link(v_booking_id, auth.uid(), p_token_key);
  return next;
end;
$$;

revoke execute on function public.staff_create_pay_link_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid, text
) from public, anon;
grant execute on function public.staff_create_pay_link_booking(
  public.dumpster_size, date, text, text, integer, text, text, text, text, text, boolean, uuid, text
) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. pay_link_reminder_token — the cron's only way to the token text.
-- Returns {state:'ok', token} | {state:'no_key'} | {state:'no_link'}
--       | {state:'no_stored_token'} | {state:'decrypt_failed'}
-- 'decrypt_failed' covers a wrong key AND a decrypt that doesn't hash back to
-- the stored token_hash.
-- -----------------------------------------------------------------------------
create or replace function public.pay_link_reminder_token(p_booking_id uuid, p_key text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_link  public.pay_links;
  v_token text;
begin
  if nullif(p_key, '') is null then
    return jsonb_build_object('state', 'no_key');
  end if;
  select * into v_link from public.pay_links
   where booking_id = p_booking_id and status = 'active';
  if not found then
    return jsonb_build_object('state', 'no_link');
  end if;
  if v_link.token_encrypted is null then
    return jsonb_build_object('state', 'no_stored_token');
  end if;
  begin
    v_token := extensions.pgp_sym_decrypt(v_link.token_encrypted, p_key);
  exception when others then
    return jsonb_build_object('state', 'decrypt_failed');
  end;
  if public._pay_link_hash(v_token) is distinct from v_link.token_hash then
    return jsonb_build_object('state', 'decrypt_failed');
  end if;
  return jsonb_build_object('state', 'ok', 'token', v_token);
end;
$$;

revoke execute on function public.pay_link_reminder_token(uuid, text) from public, anon, authenticated;
grant execute on function public.pay_link_reminder_token(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 6. pay_link_live_counts — Settings: how many links are live, and how many
-- of those can't be put in a reminder (no stored copy).
-- -----------------------------------------------------------------------------
create or replace function public.pay_link_live_counts()
returns table (live integer, without_stored_link integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only staff or owner may read pay-link counts' using errcode = '42501';
  end if;
  return query
    select count(*)::int, count(*) filter (where l.token_encrypted is null)::int
      from public.pay_links l
     where l.status = 'active';
end;
$$;

revoke execute on function public.pay_link_live_counts() from public, anon;
grant execute on function public.pay_link_live_counts() to authenticated;
