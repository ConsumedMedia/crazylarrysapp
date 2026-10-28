-- =============================================================================
-- Crazy Larry's Dumpsters — Quo call log (stage 1: webhook ingest)
-- =============================================================================
-- call_transcripts has existed since the initial schema with nothing writing
-- to it. The Quo webhook (app/api/webhooks/quo) now fills it, one row per Quo
-- call, from four event types that arrive in any order:
--   call.completed / call.missed  -> direction, status, times, duration
--   call.summary.completed        -> summary, next_steps
--   call.transcript.completed     -> transcript, transcript_dialogue
--   call.voicemail.completed      -> voicemail_transcript
--
-- Additive only. Every new column is nullable, and the existing columns keep
-- their meaning (summary and transcript stay text), so production code that
-- reads id/quo_call_id/caller_number/customer_id/duration_seconds/summary/
-- transcript/received_at keeps working unchanged (probed before applying).
--
-- Card-like digit runs are redacted by the app BEFORE this function is
-- called (lib/call-log/redact.ts). Nothing here sees unredacted text.
-- =============================================================================

alter table public.call_transcripts
  add column direction            text check (direction in ('incoming', 'outgoing')),
  add column call_status          text,
  add column call_started_at      timestamptz,
  add column has_voicemail        boolean,
  add column quo_phone_number_id  text,
  add column next_steps           text[],
  add column transcript_dialogue  jsonb,
  add column voicemail_transcript text,
  add column matched_customer_ids uuid[],
  add column match_status         text check (match_status in ('matched', 'none', 'multiple', 'unknown')),
  add column last_webhook_id      text,
  add column updated_at           timestamptz not null default now();

comment on column public.call_transcripts.caller_number is
  'The outside party (E.164 when Quo gives a phone number): the caller on incoming calls, the person called on outgoing.';
comment on column public.call_transcripts.call_status is
  'Quo call status from call.completed (answered, unanswered, abandoned, ...) or ''missed'' from call.missed.';
comment on column public.call_transcripts.transcript_dialogue is
  'Redacted transcript lines: [{speaker: staff|caller, content, start}]. transcript holds the same lines as plain text.';
comment on column public.call_transcripts.matched_customer_ids is
  'Customers whose phone matched caller_number (last 10 digits). customer_id is set only when exactly one matched.';
comment on column public.call_transcripts.match_status is
  'matched = one customer; multiple = several, none linked; none = no customer; unknown = no usable caller number.';
comment on column public.call_transcripts.last_webhook_id is
  'webhook-id header of the most recent Quo delivery applied to this row (tracing only).';

-- One row per Quo call. The table has never had rows, so this can't fail on
-- existing data; NULLs stay allowed.
create unique index call_transcripts_quo_call_id_key
  on public.call_transcripts (quo_call_id);

create trigger call_transcripts_set_updated_at
  before update on public.call_transcripts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- ingest_quo_call_event — upsert one verified webhook event into its call row.
--
-- p_event keys (all optional, absent/null = "this event doesn't carry it"):
--   caller_number, direction, call_status, call_started_at, duration_seconds,
--   has_voicemail, quo_phone_number_id, summary, next_steps (array),
--   transcript, transcript_dialogue (array), voicemail_transcript
--
-- Order-independent and retry-safe: each event fills only the fields it
-- carries (COALESCE(new, old)), so a retried delivery rewrites the same values
-- and a transcript arriving before call.completed is kept when it lands.
--
-- Customer match: last 10 digits of caller_number against customers.phone.
-- Exactly one -> customer_id; several -> left unlinked, ids recorded. A link,
-- once made, is never replaced by a later event.
--
-- SECURITY INVOKER and executable by service_role only: the webhook route
-- calls it with the service client after verifying Quo's signature. No user
-- session (anon or authenticated) can call it.
-- -----------------------------------------------------------------------------
create or replace function public.ingest_quo_call_event(
  p_call_id    text,
  p_webhook_id text,
  p_event      jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_caller   text := nullif(btrim(p_event ->> 'caller_number'), '');
  v_digits   text := right(regexp_replace(coalesce(v_caller, ''), '\D', '', 'g'), 10);
  v_ids      uuid[];
  v_match    text;
  v_customer uuid;
  v_id       uuid;
begin
  if p_call_id is null or btrim(p_call_id) = '' then
    raise exception 'ingest_quo_call_event: call id is required'
      using errcode = '22023';
  end if;

  if length(v_digits) = 10 then
    select coalesce(array_agg(c.id order by c.created_at), '{}')
      into v_ids
      from public.customers c
     where right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = v_digits;
    v_match := case cardinality(v_ids)
                 when 0 then 'none'
                 when 1 then 'matched'
                 else 'multiple'
               end;
    v_customer := case when cardinality(v_ids) = 1 then v_ids[1] end;
  elsif v_caller is not null then
    v_match := 'unknown';
  end if;

  insert into public.call_transcripts as t (
    quo_call_id, caller_number, direction, call_status, call_started_at,
    duration_seconds, has_voicemail, quo_phone_number_id,
    summary, next_steps, transcript, transcript_dialogue, voicemail_transcript,
    customer_id, matched_customer_ids, match_status, last_webhook_id
  ) values (
    p_call_id,
    v_caller,
    p_event ->> 'direction',
    p_event ->> 'call_status',
    (p_event ->> 'call_started_at')::timestamptz,
    (p_event ->> 'duration_seconds')::integer,
    (p_event ->> 'has_voicemail')::boolean,
    p_event ->> 'quo_phone_number_id',
    p_event ->> 'summary',
    case when jsonb_typeof(p_event -> 'next_steps') = 'array'
         then array(select jsonb_array_elements_text(p_event -> 'next_steps')) end,
    p_event ->> 'transcript',
    case when jsonb_typeof(p_event -> 'transcript_dialogue') = 'array'
         then p_event -> 'transcript_dialogue' end,
    p_event ->> 'voicemail_transcript',
    v_customer,
    v_ids,
    v_match,
    p_webhook_id
  )
  on conflict (quo_call_id) do update set
    caller_number        = coalesce(excluded.caller_number, t.caller_number),
    direction            = coalesce(excluded.direction, t.direction),
    call_status          = coalesce(excluded.call_status, t.call_status),
    call_started_at      = coalesce(excluded.call_started_at, t.call_started_at),
    duration_seconds     = coalesce(excluded.duration_seconds, t.duration_seconds),
    has_voicemail        = coalesce(excluded.has_voicemail, t.has_voicemail),
    quo_phone_number_id  = coalesce(excluded.quo_phone_number_id, t.quo_phone_number_id),
    summary              = coalesce(excluded.summary, t.summary),
    next_steps           = coalesce(excluded.next_steps, t.next_steps),
    transcript           = coalesce(excluded.transcript, t.transcript),
    transcript_dialogue  = coalesce(excluded.transcript_dialogue, t.transcript_dialogue),
    voicemail_transcript = coalesce(excluded.voicemail_transcript, t.voicemail_transcript),
    customer_id          = coalesce(t.customer_id, excluded.customer_id),
    matched_customer_ids = case when t.customer_id is not null then t.matched_customer_ids
                                else coalesce(excluded.matched_customer_ids, t.matched_customer_ids) end,
    match_status         = case when t.customer_id is not null then t.match_status
                                else coalesce(excluded.match_status, t.match_status) end,
    last_webhook_id      = coalesce(excluded.last_webhook_id, t.last_webhook_id)
  returning t.id into v_id;

  return v_id;
end;
$$;

revoke all on function public.ingest_quo_call_event(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_quo_call_event(text, text, jsonb) to service_role;
