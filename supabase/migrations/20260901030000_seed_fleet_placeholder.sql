-- =============================================================================
-- Crazy Larry's Dumpsters — Phase 2: PLACEHOLDER fleet seed
-- =============================================================================
-- 20 synthetic units across the three sizes with a varied status spread, so the
-- Fleet Status Board renders against realistic data before Larry's real fleet
-- list is available.
--
-- >>> REMOVE / REPLACE WHEN REAL FLEET DATA ARRIVES <<<
-- Purge with:
--   delete from public.status_log
--    where entity_type = 'dumpster'
--      and entity_id in (select id from public.dumpsters where unit_number like 'CL-1%');
--   delete from public.dumpsters where unit_number like 'CL-1%';
--
-- Idempotent: re-running does nothing (on conflict on unit_number).
-- =============================================================================

-- The dumpsters_log_created trigger would stamp every unit's first status_log
-- row at now(); we want backdated history instead, so suppress it for the seed.
alter table public.dumpsters disable trigger dumpsters_log_created;

with seed(unit_number, size, status, condition_notes, day_in_status) as (
  values
    -- 10 yd ---------------------------------------------------------------
    ('CL-101', '10yd'::public.dumpster_size, 'available'::public.dumpster_status, null,                                                         null),
    ('CL-102', '10yd', 'available',      null,                                                                                                 null),
    ('CL-103', '10yd', 'deployed',       null,                                                                                                 3),
    ('CL-104', '10yd', 'available',      null,                                                                                                 null),
    ('CL-105', '10yd', 'reserved',       null,                                                                                                 1),
    ('CL-106', '10yd', 'out_of_service', 'Hydraulic tailgate seal weeping — replacement seal on order',                                         null),
    ('CL-107', '10yd', 'available',      'Fresh repaint 8/2025',                                                                                null),
    -- 15 yd ---------------------------------------------------------------
    ('CL-108', '15yd', 'available',      null,                                                                                                 null),
    ('CL-109', '15yd', 'deployed',       null,                                                                                                 4),
    ('CL-110', '15yd', 'available',      null,                                                                                                 null),
    ('CL-111', '15yd', 'overdue',        null,                                                                                                 9),
    ('CL-112', '15yd', 'reserved',       null,                                                                                                 2),
    ('CL-113', '15yd', 'available',      null,                                                                                                 null),
    ('CL-114', '15yd', 'deployed',       null,                                                                                                 1),
    -- 20 yd ---------------------------------------------------------------
    ('CL-115', '20yd', 'available',      null,                                                                                                 null),
    ('CL-116', '20yd', 'deployed',       null,                                                                                                 6),
    ('CL-117', '20yd', 'available',      null,                                                                                                 null),
    ('CL-118', '20yd', 'overdue',        'Customer non-responsive; voicemail left 8/28',                                                        12),
    ('CL-119', '20yd', 'reserved',       null,                                                                                                 3),
    ('CL-120', '20yd', 'out_of_service', 'Floor rust remediation in progress',                                                                  null)
),
ins as (
  insert into public.dumpsters (unit_number, size, status, condition_notes)
  select unit_number, size, status, condition_notes from seed
  on conflict (unit_number) do nothing
  returning id, unit_number, status
)
insert into public.status_log (entity_type, entity_id, old_status, new_status, changed_by, changed_at)
select
  'dumpster',
  ins.id,
  x.old_status,
  x.new_status,
  null,
  x.changed_at
from ins
join seed using (unit_number)
cross join lateral (
  values
    -- creation row: NULL -> available, ~75 days ago
    (null::text, 'available'::text, now() - interval '75 days'),
    -- transition into current status, backdated by day_in_status (if not available)
    (
      case when seed.status <> 'available' then 'available'::text end,
      case when seed.status <> 'available' then seed.status::text end,
      now() - make_interval(days => coalesce(seed.day_in_status, 0))
    )
) as x(old_status, new_status, changed_at)
where x.new_status is not null;

alter table public.dumpsters enable trigger dumpsters_log_created;
