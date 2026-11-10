-- =============================================================================
-- Crazy Larry's Dumpsters — Quo call log, stage 2B: transcript segments and
-- backfill-safe ingest
-- =============================================================================
-- A paused and resumed call has one recording, and so one transcript, per
-- recorded stretch. Stage 1 kept only the transcript that arrived last. This
-- keeps every stretch ("segment") and shows them merged in call order.
--
-- 1. call_transcripts.transcript_segments jsonb (nullable; additive):
--      [{key, order_at, recording_id, duration, wrapped, lines:[...]}, ...]
--    transcript and transcript_dialogue are then DERIVED from it: the lines of
--    each segment in order, with a divider line between segments.
-- 2. Helpers, all SECURITY INVOKER, search_path=public, service_role only:
--      _redact_card_numbers(text)     same rule as lib/call-log/redact.ts
--      _quo_segment(jsonb, boolean)   one normalised, redacted, keyed segment
--      _quo_merge_segments(jsonb)     de-duplicated, ordered set + merged text
-- 3. ingest_quo_call_event gains p_source text default 'webhook':
--      'webhook'   as before: a value an event carries replaces the old one.
--      'backfill'  fill-only: a value is written only where the row has none,
--                  so the backfill never overwrites what the webhook stored.
--                  The ONE exception is a complete REST transcript set
--                  (p_event.transcript_segments), which replaces the segment
--                  set: REST is the source the webhook's segments came from.
--    New p_event keys:
--      transcript_segment   {lines, order_at, recording_id, duration}: one
--                           segment; added unless its key is already stored.
--      transcript_segments  [same shape, ...]: backfill only; replaces the set
--                           when at least one segment in it has lines.
--    Purged rows (transcript_purged_at set) stay purged: no segment, merge or
--    transcript field is ever written to them again.
-- 4. purge_call_transcripts also blanks transcript_segments.
--
-- Keys. A segment's key is 'seg_' || md5 of its redacted line texts joined by
-- newlines, computed HERE (any key the caller sends is ignored). The same
-- stretch from a retried webhook, or from the webhook and the REST backfill,
-- has the same key and is stored once. lib/call-log/segments.ts computes the
-- same key.
--
-- Order. Wrapped stage-1 text first (segment 0), then by order_at (REST
-- startTime, else the webhook's createdAt), missing times last, then by key.
--
-- Dividers. Between two segments with lines: {speaker:'divider', content:
-- 'Call resumed', start/end/user_id null, has_identifier false}; in plain text
-- '— Call resumed —'. Never staff, caller or unknown, so it can't read as
-- something somebody said. Line speakers other than staff/caller/unknown
-- (including 'divider') become 'unknown' on the way in, so a caller can't
-- forge a divider.
--
-- Redaction. Text arrives redacted by the app. The database redacts again:
-- every line as a segment is stored, every line as it is merged, and the
-- merged plain text as a whole.
--
-- Stage-1 rows. A row with a stage-1 transcript and no segments keeps working
-- as before for stage-1 events. When its first segment arrives, its existing
-- dialogue is wrapped as segment 0 (wrapped:true) first. If the new segment
-- has the same text, it is the same key and nothing is added. On a row that
-- already has segments, a stage-1 shaped transcript_dialogue joins the set as a
-- segment instead of replacing the merged text.
--
-- Signature. The 3-argument function is DROPPED and a 4-argument one with
-- p_source default 'webhook' CREATED, in this one transaction. A 3-argument
-- call by name (the webhook route via PostgREST) or by position resolves to
-- the new function with p_source = 'webhook'. Both cannot exist together: a
-- 3-argument call would then be ambiguous.
--
-- In-flight calls while this applies. ALTER TABLE (the first statement) takes
-- an ACCESS EXCLUSIVE lock on call_transcripts:
--   - An ingest already writing holds a row lock on the table, so this
--     migration waits for it to commit. It finished on the old function.
--   - An ingest that starts while this migration runs has already looked up
--     the OLD function (the drop is not visible until commit) and waits on the
--     table lock. When this commits, it carries on with the old function's
--     body: one event handled by stage-1 rules (last transcript wins, no
--     segments), the same as today. It does not fail.
--   - Every call after the commit gets the new function. PostgREST reloads its
--     schema cache on DDL; until it does, its cached call is by argument NAME,
--     which the new function accepts (p_source defaults to 'webhook').
--   - If anything did fail, the webhook route answers 500 and Quo retries for
--     about 27.5 h, so no event is lost.
-- The webhook is disabled today, so no call is expected while this applies.
-- The probe checks the waiting case with a second connection.
--
-- Concurrency. Two events for the same call are serialised by a transaction
-- advisory lock on the call id, so two segments arriving together can't both
-- read "no segments yet" and drop one another.
--
-- Built from the LIVE definitions read 2026-11-10 (ingest_quo_call_event md5
-- 19d19f88a55e6437196db5987952abe9, purge_call_transcripts md5
-- 05aa455352aff555361da37aa3a8430d), which equal 20261110000000 apart from
-- whitespace.
-- =============================================================================

alter table public.call_transcripts
  add column transcript_segments jsonb;

comment on column public.call_transcripts.transcript_segments is
  'Redacted transcript segments, one per recorded stretch of the call: [{key, order_at, recording_id, duration, wrapped, lines}]. When set, transcript and transcript_dialogue are derived from it (ordered, divider between segments). NULL = stage-1 row or no transcript.';

comment on column public.call_transcripts.transcript_dialogue is
  'Redacted transcript lines: [{speaker: staff|caller|unknown|divider, content, start, end, user_id, has_identifier}]. A divider line marks where a paused call resumed and is nobody''s speech. transcript holds the same lines as plain text.';

-- -----------------------------------------------------------------------------
-- _redact_card_numbers — the database copy of lib/call-log/redact.ts:
-- 13–19 digits, optionally grouped by single spaces or dashes, not touching
-- another digit or dash.
-- -----------------------------------------------------------------------------
create function public._redact_card_numbers(p_text text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select regexp_replace(p_text, '(?<![0-9-])[0-9](?:[ -]?[0-9]){12,18}(?![0-9-])', '[card number removed]', 'g')
$$;

revoke all on function public._redact_card_numbers(text) from public, anon, authenticated;
grant execute on function public._redact_card_numbers(text) to service_role;

-- -----------------------------------------------------------------------------
-- _quo_segment — one segment, normalised. NULL when it has no non-empty line.
--   p_seg: {lines: [...], order_at, recording_id, duration}
-- -----------------------------------------------------------------------------
create function public._quo_segment(p_seg jsonb, p_wrapped boolean)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_lines   jsonb := '[]'::jsonb;
  v_line    jsonb;
  v_content text;
  v_order   timestamptz;
  v_dur     numeric;
  v_key     text;
begin
  if jsonb_typeof(p_seg) is distinct from 'object' or jsonb_typeof(p_seg -> 'lines') is distinct from 'array' then
    return null;
  end if;

  for v_line in
    select x.e from jsonb_array_elements(p_seg -> 'lines') with ordinality as x(e, n) order by x.n
  loop
    continue when jsonb_typeof(v_line) is distinct from 'object';
    v_content := v_line ->> 'content';
    continue when v_content is null or btrim(v_content) = '';
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'speaker',        case when v_line ->> 'speaker' in ('staff', 'caller', 'unknown')
                             then v_line ->> 'speaker' else 'unknown' end,
      'content',        public._redact_card_numbers(v_content),
      'start',          case when jsonb_typeof(v_line -> 'start') = 'number' then v_line -> 'start' end,
      'end',            case when jsonb_typeof(v_line -> 'end') = 'number' then v_line -> 'end' end,
      'user_id',        case when jsonb_typeof(v_line -> 'user_id') = 'string' then v_line -> 'user_id' end,
      'has_identifier', case when jsonb_typeof(v_line -> 'has_identifier') = 'boolean'
                             then v_line -> 'has_identifier' else 'false'::jsonb end
    ));
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    return null;
  end if;

  select 'seg_' || md5(string_agg(x.e ->> 'content', E'\n' order by x.n))
    into v_key
    from jsonb_array_elements(v_lines) with ordinality as x(e, n);

  begin
    v_order := nullif(p_seg ->> 'order_at', '')::timestamptz;
  exception when others then
    v_order := null;
  end;
  if (p_seg ->> 'duration') ~ '^[0-9]+(\.[0-9]+)?$' then
    v_dur := (p_seg ->> 'duration')::numeric;
  end if;

  return jsonb_build_object(
    'key',          v_key,
    'order_at',     to_jsonb(v_order),
    'recording_id', case when jsonb_typeof(p_seg -> 'recording_id') = 'string' then p_seg -> 'recording_id' end,
    'duration',     to_jsonb(v_dur),
    'wrapped',      coalesce(p_wrapped, false),
    'lines',        v_lines
  );
end;
$$;

revoke all on function public._quo_segment(jsonb, boolean) from public, anon, authenticated;
grant execute on function public._quo_segment(jsonb, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- _quo_merge_segments — {segments, dialogue, transcript} from a segment list.
-- segments: de-duplicated by key (first in order wins) and sorted.
-- -----------------------------------------------------------------------------
create function public._quo_merge_segments(p_segments jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_seg      jsonb;
  v_line     jsonb;
  v_seen     text[] := '{}';
  v_sorted   jsonb := '[]'::jsonb;
  v_dialogue jsonb := '[]'::jsonb;
  v_text     text[] := '{}';
  v_content  text;
begin
  if jsonb_typeof(p_segments) is distinct from 'array' then
    return null;
  end if;

  for v_seg in
    select x.e
      from jsonb_array_elements(p_segments) with ordinality as x(e, n)
     where jsonb_typeof(x.e) = 'object' and x.e ->> 'key' is not null
     order by coalesce((x.e ->> 'wrapped')::boolean, false) desc,
              (x.e ->> 'order_at')::timestamptz asc nulls last,
              x.e ->> 'key',
              x.n
  loop
    continue when (v_seg ->> 'key') = any (v_seen);
    v_seen := v_seen || (v_seg ->> 'key');
    v_sorted := v_sorted || jsonb_build_array(v_seg);
    continue when jsonb_typeof(v_seg -> 'lines') is distinct from 'array'
               or jsonb_array_length(v_seg -> 'lines') = 0;

    if jsonb_array_length(v_dialogue) > 0 then
      v_dialogue := v_dialogue || jsonb_build_array(jsonb_build_object(
        'speaker', 'divider', 'content', 'Call resumed',
        'start', null, 'end', null, 'user_id', null, 'has_identifier', false));
      v_text := v_text || '— Call resumed —'::text;
    end if;

    for v_line in
      select y.e from jsonb_array_elements(v_seg -> 'lines') with ordinality as y(e, n) order by y.n
    loop
      v_content := public._redact_card_numbers(coalesce(v_line ->> 'content', ''));
      v_dialogue := v_dialogue || jsonb_build_array(
        jsonb_set(v_line, '{speaker}',
                  to_jsonb(case when v_line ->> 'speaker' in ('staff', 'caller') then v_line ->> 'speaker' else 'unknown' end))
        || jsonb_build_object('content', v_content));
      v_text := v_text || (case v_line ->> 'speaker' when 'staff' then 'Staff' when 'caller' then 'Caller' else 'Unknown' end
                           || ': ' || v_content);
    end loop;
  end loop;

  return jsonb_build_object(
    'segments',   v_sorted,
    'dialogue',   v_dialogue,
    'transcript', public._redact_card_numbers(nullif(array_to_string(v_text, E'\n'), ''))
  );
end;
$$;

revoke all on function public._quo_merge_segments(jsonb) from public, anon, authenticated;
grant execute on function public._quo_merge_segments(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- ingest_quo_call_event — 4 arguments now; see the header.
-- -----------------------------------------------------------------------------
drop function public.ingest_quo_call_event(text, text, jsonb);

create function public.ingest_quo_call_event(
  p_call_id    text,
  p_webhook_id text,
  p_event      jsonb,
  p_source     text default 'webhook'
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
  v_backfill boolean;
  v_found    boolean;
  v_old_segments   jsonb;
  v_old_transcript text;
  v_old_dialogue   jsonb;
  v_old_purged_at  timestamptz;
  v_set      jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_incoming jsonb;
  v_segments jsonb;
  v_merged   jsonb;
  v_touch    boolean := false;
begin
  if p_call_id is null or btrim(p_call_id) = '' then
    raise exception 'ingest_quo_call_event: call id is required'
      using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('webhook', 'backfill') then
    raise exception 'ingest_quo_call_event: p_source must be webhook or backfill'
      using errcode = '22023';
  end if;
  v_backfill := p_source = 'backfill';

  -- One event per call at a time (see the header).
  perform pg_advisory_xact_lock(hashtext('ingest_quo_call_event'), hashtext(p_call_id));

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

  select t.transcript_segments, t.transcript, t.transcript_dialogue, t.transcript_purged_at
    into v_old_segments, v_old_transcript, v_old_dialogue, v_old_purged_at
    from public.call_transcripts t
   where t.quo_call_id = p_call_id;
  v_found := found;

  -- Segments: never for a purged row.
  if v_old_purged_at is null then
    -- A complete REST set (backfill only) replaces the segment set.
    if v_backfill and jsonb_typeof(p_event -> 'transcript_segments') = 'array' then
      for v_item in select x.e from jsonb_array_elements(p_event -> 'transcript_segments') as x(e) loop
        v_incoming := public._quo_segment(v_item, false);
        if v_incoming is not null then
          v_set := v_set || jsonb_build_array(v_incoming);
        end if;
      end loop;
      if jsonb_array_length(v_set) > 0 then
        v_segments := v_set;
        v_touch := true;
      end if;
    end if;

    if not v_touch then
      v_incoming := case when jsonb_typeof(p_event -> 'transcript_segment') = 'object'
                         then public._quo_segment(p_event -> 'transcript_segment', false) end;
      -- A stage-1 shaped transcript on a row that already has segments joins them.
      if v_incoming is null and v_old_segments is not null
         and jsonb_typeof(p_event -> 'transcript_dialogue') = 'array' then
        v_incoming := public._quo_segment(jsonb_build_object('lines', p_event -> 'transcript_dialogue'), false);
      end if;

      if v_incoming is not null then
        v_segments := v_old_segments;
        if v_segments is null then
          v_segments := '[]'::jsonb;
          -- Wrap a stage-1 transcript as segment 0.
          if v_found and (v_old_dialogue is not null or v_old_transcript is not null) then
            v_item := public._quo_segment(jsonb_build_object('lines',
                        case when jsonb_typeof(v_old_dialogue) = 'array' and jsonb_array_length(v_old_dialogue) > 0
                             then v_old_dialogue
                             else jsonb_build_array(jsonb_build_object('speaker', 'unknown', 'content', v_old_transcript)) end),
                      true);
            if v_item is not null then
              v_segments := jsonb_build_array(v_item);
            end if;
          end if;
        end if;
        -- Already stored (a retry, or the same stretch from the other source): keep what is there.
        if not exists (select 1 from jsonb_array_elements(v_segments) as x(e) where x.e ->> 'key' = v_incoming ->> 'key') then
          v_segments := v_segments || jsonb_build_array(v_incoming);
        end if;
        v_touch := true;
      end if;
    end if;

    if v_touch then
      v_merged := public._quo_merge_segments(v_segments);
    end if;
  end if;

  insert into public.call_transcripts as t (
    quo_call_id, caller_number, direction, call_status, call_started_at,
    duration_seconds, has_voicemail, quo_phone_number_id,
    summary, next_steps, transcript, transcript_dialogue, voicemail_transcript,
    transcript_segments,
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
    case when v_touch then v_merged ->> 'transcript'
         else public._redact_card_numbers(p_event ->> 'transcript') end,
    case when v_touch then v_merged -> 'dialogue'
         when jsonb_typeof(p_event -> 'transcript_dialogue') = 'array' then p_event -> 'transcript_dialogue' end,
    p_event ->> 'voicemail_transcript',
    case when v_touch then v_merged -> 'segments' end,
    v_customer,
    v_ids,
    v_match,
    p_webhook_id
  )
  on conflict (quo_call_id) do update set
    caller_number        = case when v_backfill then coalesce(t.caller_number, excluded.caller_number)
                                else coalesce(excluded.caller_number, t.caller_number) end,
    direction            = case when v_backfill then coalesce(t.direction, excluded.direction)
                                else coalesce(excluded.direction, t.direction) end,
    call_status          = case when v_backfill then coalesce(t.call_status, excluded.call_status)
                                else coalesce(excluded.call_status, t.call_status) end,
    call_started_at      = case when v_backfill then coalesce(t.call_started_at, excluded.call_started_at)
                                else coalesce(excluded.call_started_at, t.call_started_at) end,
    duration_seconds     = case when v_backfill then coalesce(t.duration_seconds, excluded.duration_seconds)
                                else coalesce(excluded.duration_seconds, t.duration_seconds) end,
    has_voicemail        = case when v_backfill then coalesce(t.has_voicemail, excluded.has_voicemail)
                                else coalesce(excluded.has_voicemail, t.has_voicemail) end,
    quo_phone_number_id  = case when v_backfill then coalesce(t.quo_phone_number_id, excluded.quo_phone_number_id)
                                else coalesce(excluded.quo_phone_number_id, t.quo_phone_number_id) end,
    summary              = case when v_backfill then coalesce(t.summary, excluded.summary)
                                else coalesce(excluded.summary, t.summary) end,
    next_steps           = case when v_backfill then coalesce(t.next_steps, excluded.next_steps)
                                else coalesce(excluded.next_steps, t.next_steps) end,
    transcript           = case when t.transcript_purged_at is not null then null
                                when v_touch then excluded.transcript
                                when t.transcript_segments is not null then t.transcript
                                when v_backfill then coalesce(t.transcript, excluded.transcript)
                                else coalesce(excluded.transcript, t.transcript) end,
    transcript_dialogue  = case when t.transcript_purged_at is not null then null
                                when v_touch then excluded.transcript_dialogue
                                when t.transcript_segments is not null then t.transcript_dialogue
                                when v_backfill then coalesce(t.transcript_dialogue, excluded.transcript_dialogue)
                                else coalesce(excluded.transcript_dialogue, t.transcript_dialogue) end,
    transcript_segments  = case when t.transcript_purged_at is not null then null
                                when v_touch then excluded.transcript_segments
                                else t.transcript_segments end,
    voicemail_transcript = case when t.transcript_purged_at is not null then null
                                when v_backfill then coalesce(t.voicemail_transcript, excluded.voicemail_transcript)
                                else coalesce(excluded.voicemail_transcript, t.voicemail_transcript) end,
    customer_id          = coalesce(t.customer_id, excluded.customer_id),
    matched_customer_ids = case when t.customer_id is not null then t.matched_customer_ids
                                else coalesce(excluded.matched_customer_ids, t.matched_customer_ids) end,
    match_status         = case when t.customer_id is not null then t.match_status
                                else coalesce(excluded.match_status, t.match_status) end,
    last_webhook_id      = case when v_backfill then coalesce(t.last_webhook_id, excluded.last_webhook_id)
                                else coalesce(excluded.last_webhook_id, t.last_webhook_id) end
  returning t.id into v_id;

  return v_id;
end;
$$;

revoke all on function public.ingest_quo_call_event(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.ingest_quo_call_event(text, text, jsonb, text) to service_role;

-- -----------------------------------------------------------------------------
-- purge_call_transcripts — as applied in 20261110000000, plus transcript_segments.
-- Same signature, so its grants (service_role only) are kept; re-asserted.
-- -----------------------------------------------------------------------------
create or replace function public.purge_call_transcripts(p_days integer)
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
         transcript_segments  = null,
         voicemail_transcript = null,
         transcript_purged_at = now()
   where t.transcript_purged_at is null
     and coalesce(t.call_started_at, t.received_at) < now() - make_interval(days => p_days)
     and (t.transcript is not null
          or t.transcript_dialogue is not null
          or t.transcript_segments is not null
          or t.voicemail_transcript is not null);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.purge_call_transcripts(integer) from public, anon, authenticated;
grant execute on function public.purge_call_transcripts(integer) to service_role;
