-- =============================================================================
-- Crazy Larry's Dumpsters - Plan B.4: SMS opt-outs (Quo STOP handling)
-- =============================================================================
-- An inbound text on the yard line that is an opt-out keyword stops texts to
-- that number. customers.sms_consent alone can't hold this: every booking path
-- (_create_booking_core, record_pay_link_payment) overwrites it with that
-- booking's answer, so a STOP stored only there would be undone by the next
-- booking. The block lives on the phone number instead.
--
-- Decisions (Nathan, 2026-11-13):
--   * STOP-family keyword alone        -> opted out
--   * CANCEL alone                      -> opted out, and staff are asked to
--                                          check whether a booking cancel was meant
--   * an opt-out word inside a longer   -> texts to that number are blocked until
--     message                             staff resolve it (treat as STOP, or not)
--   * START / UNSTOP                    -> the opt-out ends; consent is NOT restored
--   * resolved review text is purged 30 days after it was resolved
--
-- 1. _sms_phone_key(text): digits only; 10 digits, or 11 starting with 1 -> the
--    last 10. Anything else -> NULL. Owner only.
-- 2. sms_opt_outs: one row per phone key (opted_out | opted_in). Staff read.
-- 3. sms_inbound_events: one row per keyword message, unique by Quo's message
--    id (webhook retries and duplicate deliveries add nothing). Staff read.
-- 4. consent_records.source gains 'sms_reply' and 'staff_review'.
-- 5. notifications_log.failure_category gains 'opted_out'.
-- 6. _apply_sms_opt_out (owner only), record_sms_inbound and sms_block_status
--    (service_role only), resolve_sms_review (staff, via authenticated),
--    purge_sms_review_text (service_role only, refuses fewer than 30 days).
--
-- No existing function, policy or table grant changes. Nothing is backfilled.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Phone key
-- -----------------------------------------------------------------------------
create function public._sms_phone_key(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when length(s.d) = 10 then s.d
           when length(s.d) = 11 and left(s.d, 1) = '1' then right(s.d, 10)
         end
    from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) s
$$;

comment on function public._sms_phone_key(text) is
  'US phone key for SMS opt-outs: digits only; 10 digits, or 11 starting with 1 -> the last 10; anything else NULL. Mirrored by lib/sms-inbound/phone-key.ts.';

-- -----------------------------------------------------------------------------
-- 2. sms_opt_outs
-- -----------------------------------------------------------------------------
create table public.sms_opt_outs (
  phone_key        text primary key
                   constraint sms_opt_outs_phone_key_check check (phone_key ~ '^[0-9]{10}$'),
  status           text not null
                   constraint sms_opt_outs_status_check check (status in ('opted_out', 'opted_in')),
  last_keyword     text not null,
  last_message_id  text not null,
  -- When the message that set this status was received. A later-arriving but
  -- older message never overrides a newer one (Quo doesn't guarantee order).
  last_changed_at  timestamptz not null,
  opted_out_at     timestamptz,
  opted_in_at      timestamptz,
  updated_at       timestamptz not null default now(),
  constraint sms_opt_outs_times_check check (
    (status = 'opted_out' and opted_out_at is not null)
    or (status = 'opted_in' and opted_in_at is not null)
  )
);

comment on table public.sms_opt_outs is
  'Numbers that replied STOP (opted_out) or later START/UNSTOP (opted_in), keyed by _sms_phone_key. Every SMS checks this through sms_block_status. Written only by record_sms_inbound / resolve_sms_review.';

alter table public.sms_opt_outs enable row level security;
revoke all on public.sms_opt_outs from anon, authenticated;
grant select on public.sms_opt_outs to authenticated;
create policy "sms_opt_outs: staff read" on public.sms_opt_outs
  for select using (public.is_staff());

-- -----------------------------------------------------------------------------
-- 3. sms_inbound_events
-- -----------------------------------------------------------------------------
create table public.sms_inbound_events (
  id                     uuid primary key default gen_random_uuid(),
  message_id             text not null
                         constraint sms_inbound_events_message_id_key unique,
  webhook_id             text not null,
  kind                   text not null
                         constraint sms_inbound_events_kind_check check (kind in ('opt_out', 'opt_in', 'review')),
  keyword                text not null
                         constraint sms_inbound_events_keyword_check check (
                           keyword in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'START', 'UNSTOP')),
  phone_key              text
                         constraint sms_inbound_events_phone_key_check check (phone_key is null or phone_key ~ '^[0-9]{10}$'),
  customer_ids           uuid[] not null default '{}',
  received_at            timestamptz not null,
  needs_review           boolean not null default false,
  review_reason          text
                         constraint sms_inbound_events_review_reason_check check (review_reason in ('cancel_keyword', 'keyword_in_message')),
  -- The message, card numbers redacted, kept only for keyword_in_message rows
  -- and purged 30 days after staff resolve it.
  review_text            text
                         constraint sms_inbound_events_review_text_check check (review_text is null or char_length(review_text) <= 500),
  reviewed_at            timestamptz,
  reviewed_by            uuid references public.profiles(id) on delete set null,
  review_outcome         text
                         constraint sms_inbound_events_review_outcome_check check (review_outcome in ('treated_as_stop', 'not_a_stop', 'checked')),
  review_text_purged_at  timestamptz,
  created_at             timestamptz not null default now(),

  constraint sms_inbound_events_shape_check check (
    case kind
      when 'opt_out' then keyword in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT')
                          and review_reason is not distinct from (case when keyword = 'CANCEL' then 'cancel_keyword' end)
      when 'opt_in'  then keyword in ('START', 'UNSTOP') and review_reason is null
      when 'review'  then keyword in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT')
                          and review_reason = 'keyword_in_message'
    end
  ),
  constraint sms_inbound_events_needs_review_check check (needs_review = (review_reason is not null)),
  constraint sms_inbound_events_review_text_kind_check check (review_text is null or review_reason = 'keyword_in_message'),
  constraint sms_inbound_events_resolution_check check (
    (reviewed_at is null) = (review_outcome is null)
    and (reviewed_at is null or needs_review)
    and (review_outcome is null
         or (review_reason = 'cancel_keyword' and review_outcome = 'checked')
         or (review_reason = 'keyword_in_message' and review_outcome in ('treated_as_stop', 'not_a_stop')))
  ),
  constraint sms_inbound_events_purge_check check (review_text_purged_at is null or (reviewed_at is not null and review_text is null))
);

create index sms_inbound_events_open_review_idx
  on public.sms_inbound_events (phone_key)
  where needs_review and reviewed_at is null;

comment on table public.sms_inbound_events is
  'Inbound yard-line texts that were opt-out or opt-in keywords, or held an opt-out word inside a longer message (review). One row per Quo message id. Other texts are never stored.';

alter table public.sms_inbound_events enable row level security;
revoke all on public.sms_inbound_events from anon, authenticated;
grant select on public.sms_inbound_events to authenticated;
create policy "sms_inbound_events: staff read" on public.sms_inbound_events
  for select using (public.is_staff());

-- -----------------------------------------------------------------------------
-- 4. consent_records.source: + sms_reply, staff_review
-- -----------------------------------------------------------------------------
alter table public.consent_records drop constraint consent_records_source_check;
alter table public.consent_records add constraint consent_records_source_check
  check (source = any (array['phone_verbal'::text, 'pay_page'::text, 'sms_reply'::text, 'staff_review'::text]));

-- -----------------------------------------------------------------------------
-- 5. notifications_log.failure_category: + opted_out
-- -----------------------------------------------------------------------------
alter table public.notifications_log drop constraint notifications_log_failure_category_check;
alter table public.notifications_log add constraint notifications_log_failure_category_check
  check ((failure_category is null) or (failure_category = any (array[
    'disabled'::text, 'test_mode'::text, 'not_configured'::text, 'account_blocked'::text,
    'provider_rejected'::text, 'rate_limited'::text, 'transient'::text, 'recipient_missing'::text,
    'no_consent'::text, 'opted_out'::text])));

-- -----------------------------------------------------------------------------
-- 6a. _apply_sms_opt_out: owner only. Called by record_sms_inbound and
-- resolve_sms_review (both DEFINER, owned by postgres).
--   * the number's row becomes opted_out, unless a newer message already set it
--   * every customer with that number: sms_consent = false, and a
--     consent_records row (granted false). Consent only ever goes false here,
--     so it is applied whatever the message order.
-- Returns the matched customer ids.
-- -----------------------------------------------------------------------------
create function public._apply_sms_opt_out(
  p_phone_key   text,
  p_keyword     text,
  p_message_id  text,
  p_received_at timestamptz,
  p_source      text,
  p_recorded_by uuid
)
returns uuid[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_customers uuid[];
begin
  insert into public.sms_opt_outs as o
         (phone_key, status, last_keyword, last_message_id, last_changed_at, opted_out_at)
  values (p_phone_key, 'opted_out', p_keyword, p_message_id, p_received_at, p_received_at)
  on conflict (phone_key) do update
     set status          = 'opted_out',
         last_keyword    = excluded.last_keyword,
         last_message_id = excluded.last_message_id,
         last_changed_at = excluded.last_changed_at,
         opted_out_at    = excluded.opted_out_at,
         updated_at      = now()
   where o.last_changed_at <= excluded.last_changed_at;

  select coalesce(array_agg(c.id order by c.id), '{}')
    into v_customers
    from public.customers c
   where public._sms_phone_key(c.phone) = p_phone_key;

  update public.customers c
     set sms_consent = false
   where c.id = any (v_customers)
     and c.sms_consent;

  insert into public.consent_records (customer_id, channel, granted, source, recorded_by, recorded_at)
  select u.id, 'sms', false, p_source, p_recorded_by, now()
    from unnest(v_customers) as u(id);

  return v_customers;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6b. record_sms_inbound: the webhook's one write. Service role only.
-- Idempotent by Quo's message id: a repeat returns status 'duplicate' and
-- changes nothing.
-- -----------------------------------------------------------------------------
create function public.record_sms_inbound(
  p_message_id  text,
  p_webhook_id  text,
  p_sender      text,
  p_kind        text,
  p_keyword     text,
  p_received_at timestamptz,
  p_review_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key       text := public._sms_phone_key(p_sender);
  v_reason    text;
  v_event     uuid;
  v_customers uuid[] := '{}';
begin
  if p_message_id is null or btrim(p_message_id) = '' or length(p_message_id) > 200
     or p_webhook_id is null or btrim(p_webhook_id) = '' or length(p_webhook_id) > 200 then
    raise exception 'record_sms_inbound: message and delivery ids are required' using errcode = '22023';
  end if;
  if p_received_at is null then
    raise exception 'record_sms_inbound: received time is required' using errcode = '22023';
  end if;
  if p_kind = 'opt_out' and p_keyword in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT') then
    v_reason := case when p_keyword = 'CANCEL' then 'cancel_keyword' end;
  elsif p_kind = 'opt_in' and p_keyword in ('START', 'UNSTOP') then
    v_reason := null;
  elsif p_kind = 'review' and p_keyword in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT') then
    v_reason := 'keyword_in_message';
  else
    raise exception 'record_sms_inbound: unknown kind or keyword' using errcode = '22023';
  end if;
  if p_review_text is not null and (p_kind <> 'review' or char_length(p_review_text) > 500) then
    raise exception 'record_sms_inbound: review text only on a review message, at most 500 characters' using errcode = '22023';
  end if;

  insert into public.sms_inbound_events
         (message_id, webhook_id, kind, keyword, phone_key, received_at, needs_review, review_reason, review_text)
  values (p_message_id, p_webhook_id, p_kind, p_keyword, v_key, p_received_at,
          v_reason is not null, v_reason, case when p_kind = 'review' then p_review_text end)
  on conflict (message_id) do nothing
  returning id into v_event;

  if v_event is null then
    return jsonb_build_object('status', 'duplicate');
  end if;

  if v_key is not null then
    if p_kind = 'opt_out' then
      v_customers := public._apply_sms_opt_out(v_key, p_keyword, p_message_id, p_received_at, 'sms_reply', null);
    else
      select coalesce(array_agg(c.id order by c.id), '{}') into v_customers
        from public.customers c
       where public._sms_phone_key(c.phone) = v_key;
    end if;

    if p_kind = 'opt_in' then
      insert into public.sms_opt_outs as o
             (phone_key, status, last_keyword, last_message_id, last_changed_at, opted_in_at)
      values (v_key, 'opted_in', p_keyword, p_message_id, p_received_at, p_received_at)
      on conflict (phone_key) do update
         set status          = 'opted_in',
             last_keyword    = excluded.last_keyword,
             last_message_id = excluded.last_message_id,
             last_changed_at = excluded.last_changed_at,
             opted_in_at     = excluded.opted_in_at,
             updated_at      = now()
       where o.last_changed_at <= excluded.last_changed_at;
    end if;

    update public.sms_inbound_events set customer_ids = v_customers where id = v_event;
  end if;

  return jsonb_build_object(
    'status', 'recorded',
    'kind', p_kind,
    'matched', coalesce(array_length(v_customers, 1), 0),
    'needs_review', v_reason is not null,
    'has_number', v_key is not null
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 6c. sms_block_status: what every SMS checks first. Service role only.
--   'opted_out'       the number replied STOP (and no newer START)
--   'pending_review'  an opt-out word inside a longer message, not yet resolved
--   NULL              not blocked (or not a US number)
-- -----------------------------------------------------------------------------
create function public.sms_block_status(p_phone text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when k.key is null then null
           when exists (select 1 from public.sms_opt_outs o
                         where o.phone_key = k.key and o.status = 'opted_out') then 'opted_out'
           when exists (select 1 from public.sms_inbound_events e
                         where e.phone_key = k.key and e.review_reason = 'keyword_in_message'
                           and e.reviewed_at is null) then 'pending_review'
         end
    from (select public._sms_phone_key(p_phone) as key) k
$$;

-- -----------------------------------------------------------------------------
-- 6d. resolve_sms_review: staff, on their own session.
--   cancel_keyword rows      -> 'checked' only (texts are already stopped)
--   keyword_in_message rows  -> 'treated_as_stop' (opts the number out, consent
--                               source staff_review) or 'not_a_stop' (lifts the hold)
-- The text stays until purge_sms_review_text clears it, 30 days later.
-- -----------------------------------------------------------------------------
create function public.resolve_sms_review(p_event_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.sms_inbound_events%rowtype;
  v_customers uuid[] := '{}';
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select * into v_event from public.sms_inbound_events where id = p_event_id for update;
  if not found or not v_event.needs_review then
    raise exception 'resolve_sms_review: nothing to review' using errcode = '22023';
  end if;
  if v_event.reviewed_at is not null then
    if v_event.review_outcome = p_outcome then
      return jsonb_build_object('status', 'already_resolved', 'outcome', p_outcome);
    end if;
    raise exception 'resolve_sms_review: already resolved as %', v_event.review_outcome
      using errcode = '22023', hint = 'already_resolved';
  end if;
  if not ((v_event.review_reason = 'cancel_keyword' and p_outcome = 'checked')
          or (v_event.review_reason = 'keyword_in_message' and p_outcome in ('treated_as_stop', 'not_a_stop'))) then
    raise exception 'resolve_sms_review: % is not an outcome for this message', coalesce(p_outcome, 'null')
      using errcode = '22023';
  end if;

  if p_outcome = 'treated_as_stop' and v_event.phone_key is not null then
    v_customers := public._apply_sms_opt_out(
      v_event.phone_key, v_event.keyword, v_event.message_id, v_event.received_at, 'staff_review', auth.uid());
  end if;

  update public.sms_inbound_events
     set reviewed_at = now(), reviewed_by = auth.uid(), review_outcome = p_outcome
   where id = p_event_id;

  return jsonb_build_object('status', 'resolved', 'outcome', p_outcome,
                            'matched', coalesce(array_length(v_customers, 1), 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- 6e. purge_sms_review_text: blank review text resolved more than p_days ago.
-- SECURITY INVOKER, service_role only (the daily cron). Refuses fewer than 30.
-- -----------------------------------------------------------------------------
create function public.purge_sms_review_text(p_days integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_days is null or p_days < 30 then
    raise exception 'purge_sms_review_text: retention must be at least 30 days (got %)', coalesce(p_days::text, 'null')
      using errcode = '22023';
  end if;

  update public.sms_inbound_events
     set review_text = null, review_text_purged_at = now()
   where review_text is not null
     and reviewed_at is not null
     and reviewed_at < now() - make_interval(days => p_days);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants. Default privileges give service_role EXECUTE on new functions, so the
-- owner-only helpers revoke it explicitly.
-- -----------------------------------------------------------------------------
revoke all on function public._sms_phone_key(text) from public, anon, authenticated, service_role;
revoke all on function public._apply_sms_opt_out(text, text, text, timestamptz, text, uuid) from public, anon, authenticated, service_role;

revoke all on function public.record_sms_inbound(text, text, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_sms_inbound(text, text, text, text, text, timestamptz, text) to service_role;

revoke all on function public.sms_block_status(text) from public, anon, authenticated;
grant execute on function public.sms_block_status(text) to service_role;

revoke all on function public.purge_sms_review_text(integer) from public, anon, authenticated;
grant execute on function public.purge_sms_review_text(integer) to service_role;

revoke all on function public.resolve_sms_review(uuid, text) from public, anon, service_role;
grant execute on function public.resolve_sms_review(uuid, text) to authenticated;
