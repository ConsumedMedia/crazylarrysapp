-- =============================================================================
-- Crazy Larry's Dumpsters — Quo call log, stage 2A: transcript purge
-- =============================================================================
-- Transcript text is kept for TRANSCRIPT_RETENTION_DAYS (lib/call-log/config.ts,
-- 180 today), counted from the call. After that the daily cron, behind
-- CL_CALL_TRANSCRIPT_PURGE_ENABLED, calls purge_call_transcripts, which blanks
-- transcript, transcript_dialogue and voicemail_transcript and stamps
-- transcript_purged_at. The row itself stays: time, number, duration,
-- customer, summary and next steps.
--
-- 1. call_transcripts.transcript_purged_at (nullable; additive).
-- 2. purge_call_transcripts(p_days): SECURITY INVOKER, service_role only,
--    refuses fewer than 30 days.
-- 3. ingest_quo_call_event: unchanged except that a purged row's transcript
--    fields stay empty whatever arrives later (webhook retry or backfill).
--    Re-created from the LIVE definition (identical to 20261028000000 apart
--    from whitespace, checked read-only 2026-11-10); signature and grants are
--    unchanged and re-asserted.
-- =============================================================================

alter table public.call_transcripts
  add column transcript_purged_at timestamptz;

comment on column public.call_transcripts.transcript_purged_at is
  'When purge_call_transcripts removed this call''s transcript text (transcript, transcript_dialogue, voicemail_transcript). NULL = not purged. Once set, ingest never refills those fields.';

-- -----------------------------------------------------------------------------
-- purge_call_transcripts — blank transcript text older than p_days.
--
-- Age is counted from the call (call_started_at), or from when the row was
-- first stored if Quo never sent a start time. Only rows that still hold some
-- transcript text are touched, so a second run the same day returns 0.
--
-- SECURITY INVOKER, executable by service_role only (the daily cron's service
-- client). If EXECUTE were ever granted by mistake, the caller's own RLS and
-- table rights still apply.
-- -----------------------------------------------------------------------------
create function public.purge_call_transcripts(p_days integer)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_days is null or p_days < 30 then
    raise exception 'purge_call_transcripts: retention must be at least 30 days (got %)', coalesce(p_days::text, 'null')
      using errcode = '22023';
  end if;

  update public.call_transcripts t
     set transcript           = null,
         transcript_dialogue  = null,
         voicemail_transcript = null,
         transcript_purged_at = now()
   where t.transcript_purged_at is null
     and coalesce(t.call_started_at, t.received_at) < now() - make_interval(days => p_days)
     and (t.transcript is not null
          or t.transcript_dialogue is not null
          or t.voicemail_transcript is not null);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.purge_call_transcripts(integer) from public, anon, authenticated;
grant execute on function public.purge_call_transcripts(integer) to service_role;

-- -----------------------------------------------------------------------------
-- ingest_quo_call_event — as before, plus: once transcript_purged_at is set,
-- transcript, transcript_dialogue and voicemail_transcript stay NULL.
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
    transcript           = case when t.transcript_purged_at is not null then null
                                else coalesce(excluded.transcript, t.transcript) end,
    transcript_dialogue  = case when t.transcript_purged_at is not null then null
                                else coalesce(excluded.transcript_dialogue, t.transcript_dialogue) end,
    voicemail_transcript = case when t.transcript_purged_at is not null then null
                                else coalesce(excluded.voicemail_transcript, t.voicemail_transcript) end,
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
