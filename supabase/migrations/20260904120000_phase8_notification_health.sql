-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 8: notification_health()
-- =============================================================================
-- Deferred from Phase 7. Two schema additions so a failed send can be told
-- apart from an intentional non-send, and so a failure can be told apart from
-- "the whole channel is down and needs a human":
--
--   1. notification_delivery_status += 'skipped' — the dev-disabled flag and a
--      test-redirect channel mismatch are not failures; counting them as
--      'failed' would make the health signal cry wolf.
--   2. notifications_log.failure_category — buckets 'failed' rows so
--      notification_health() can distinguish "the account/config is broken"
--      (account_blocked, not_configured) from one bad phone number or a
--      transient timeout.
--
-- notification_health() itself reads the last 24h per channel and returns a
-- status the Overview banner can act on directly: 'ok' | 'blocked' | 'degraded'
-- | 'no_data'.
-- =============================================================================

alter type public.notification_delivery_status add value if not exists 'skipped';

alter table public.notifications_log
  add column if not exists failure_category text
    check (failure_category is null or failure_category in (
      'disabled', 'test_mode', 'not_configured',
      'account_blocked', 'provider_rejected', 'rate_limited',
      'transient', 'recipient_missing'
    ));

create or replace function public.notification_health()
returns table (
  channel          text,
  status           text, -- 'ok' | 'blocked' | 'degraded' | 'no_data'
  sent_24h         integer,
  failed_24h       integer,
  skipped_24h      integer,
  last_attempt_at  timestamptz,
  last_category    text,
  last_error       text
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
  with recent as (
    select *
    from public.notifications_log
    where created_at > now() - interval '24 hours'
  ),
  agg as (
    select
      r.channel::text as channel,
      count(*) filter (where r.delivery_status = 'sent')    as sent_24h,
      count(*) filter (where r.delivery_status = 'failed')  as failed_24h,
      count(*) filter (where r.delivery_status = 'skipped') as skipped_24h
    from recent r
    group by r.channel
  ),
  latest as (
    select distinct on (r.channel)
      r.channel::text as channel,
      r.created_at    as last_attempt_at,
      r.failure_category as last_category,
      r.error         as last_error
    from recent r
    order by r.channel, r.created_at desc
  ),
  blocked as (
    select distinct r.channel::text as channel
    from recent r
    where r.failure_category in ('account_blocked', 'not_configured')
  )
  select
    c.channel,
    case
      when a.channel is null then 'no_data'
      when b.channel is not null and coalesce(a.sent_24h, 0) = 0 then 'blocked'
      when coalesce(a.sent_24h, 0) > 0 and b.channel is null then 'ok'
      else 'degraded'
    end,
    coalesce(a.sent_24h, 0),
    coalesce(a.failed_24h, 0),
    coalesce(a.skipped_24h, 0),
    l.last_attempt_at,
    l.last_category,
    l.last_error
  from (values ('email'), ('sms')) as c(channel)
  left join agg     a on a.channel = c.channel
  left join latest  l on l.channel = c.channel
  left join blocked b on b.channel = c.channel;
end;
$$;

grant execute on function public.notification_health() to authenticated;
