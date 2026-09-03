-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 7: notifications (Quo SMS + Resend email)
-- =============================================================================
-- Sending happens in the Node layer (lib/notifications/*). This migration only
-- adjusts the DB so the Node layer has what it needs:
--
--   1. mark_overdue_bookings() returns the flagged booking ids (was: a count),
--      so /api/cron/overdue can send a per-booking overdue notice.
--   2. notifications_log gains body / error / provider_message_id — the table
--      records that a send happened but not what was sent or why it failed.
-- =============================================================================

-- 1. mark_overdue_bookings -> setof uuid ------------------------------------
drop function if exists public.mark_overdue_bookings();

create function public.mark_overdue_bookings()
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
begin
  for b in
    select id, status from public.bookings
    where status in ('active', 'pickup_scheduled')
      and pickup_date is not null
      and pickup_date < current_date
    for update
  loop
    update public.bookings set status = 'overdue' where id = b.id;
    insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by)
    values ('booking', b.id, b.status::text, 'overdue', null);
    return next b.id;
  end loop;
  return;
end;
$$;

grant execute on function public.mark_overdue_bookings() to service_role;

-- 2. notifications_log detail columns -------------------------------------
alter table public.notifications_log
  add column if not exists body                text,
  add column if not exists error               text,
  add column if not exists provider_message_id text;
